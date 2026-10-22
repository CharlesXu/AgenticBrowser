/* SPDX-License-Identifier: GPL-2.0-or-later
 * Small LibVNCServer process; it is not linked into Chromium.
 * stdin: 8-byte session password, then uint32 big-endian PNG length + PNG.
 * stdout: JSON event lines.
 * No desktop capture, OS input, clipboard, file transfer or public RFB port.
 */
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <png.h>
#include <rfb/rfb.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define WIDTH 1280
#define HEIGHT 720
#define MAX_PNG (16 * 1024 * 1024)

static volatile sig_atomic_t stopping;
static rfbClientPtr client;
static unsigned client_id;
static int announced;

static void stop(int unused) { (void)unused; stopping = 1; }
static void gone(rfbClientPtr cl) {
    if (cl == client) {
        if (announced)
            printf("{\"type\":\"disconnect\",\"client\":%u}\n", client_id);
        client = NULL;
        announced = 0;
    }
}
static enum rfbNewClientAction connected(rfbClientPtr cl) {
    if (client) return RFB_CLIENT_REFUSE;
    client = cl;
    client_id++;
    announced = 0;
    cl->clientGoneHook = gone;
    return RFB_CLIENT_ACCEPT;
}
static void pointer(int mask, int x, int y, rfbClientPtr cl) {
    if (cl == client && announced)
        printf("{\"type\":\"pointer\",\"client\":%u,\"mask\":%d,\"x\":%d,\"y\":%d}\n",
               client_id, mask, x, y);
}
static void key(rfbBool down, rfbKeySym sym, rfbClientPtr cl) {
    if (cl == client && announced)
        printf("{\"type\":\"key\",\"client\":%u,\"down\":%s,\"keysym\":%u}\n",
               client_id, down ? "true" : "false", (unsigned)sym);
}
static void no_clipboard(char *text, int length, rfbClientPtr cl) {
    (void)text; (void)length; (void)cl;
}
static void lossless(rfbClientPtr cl) {
    // Reapply after every SetEncodings request: noVNC's default quality hint
    // otherwise enables JPEG in Tight. Keep the library's lossless zlib path.
#if defined(LIBVNCSERVER_HAVE_LIBZ) || defined(LIBVNCSERVER_HAVE_LIBPNG)
    cl->tightQualityLevel = -1;
#ifdef LIBVNCSERVER_HAVE_LIBJPEG
    cl->turboQualityLevel = -1;
#endif
#endif
}

static int decode(rfbScreenInfoPtr screen, const unsigned char *bytes, size_t size) {
    png_image image;
    memset(&image, 0, sizeof(image));
    image.version = PNG_IMAGE_VERSION;
    if (!png_image_begin_read_from_memory(&image, bytes, size)) return 0;
    if (image.width != WIDTH || image.height != HEIGHT) {
        png_image_free(&image);
        return 0;
    }
    image.format = PNG_FORMAT_RGBA;
    int result = png_image_finish_read(&image, NULL, screen->frameBuffer, 0, NULL);
    png_image_free(&image);
    if (result) rfbMarkRectAsModified(screen, 0, 0, WIDTH, HEIGHT);
    return result;
}

int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IOLBF, 0);
    signal(SIGTERM, stop);
    signal(SIGINT, stop);
    signal(SIGPIPE, SIG_IGN);
    // Keep the temporary RFB password out of argv, environment and logs.
    char password[9] = {0};
    size_t password_size = 0;
    while (password_size < 8) {
        ssize_t count = read(STDIN_FILENO, password + password_size, 8 - password_size);
        if (count <= 0) return 1;
        password_size += count;
    }
    char *passwords[] = {password, NULL};
    rfbLogEnable(getenv("AGENTIC_VNC_DEBUG") != NULL);
    rfbScreenInfoPtr screen = rfbGetScreen(&argc, argv, WIDTH, HEIGHT, 8, 3, 4);
    if (!screen) return 1;
    screen->frameBuffer = calloc(WIDTH * HEIGHT, 4);
    if (!screen->frameBuffer) return 1;
    screen->desktopName = "Agentic Browser / Space B";
    screen->serverFormat.redShift = 0;
    screen->serverFormat.greenShift = 8;
    screen->serverFormat.blueShift = 16;
    screen->serverFormat.bigEndian = FALSE;
    screen->alwaysShared = TRUE;
    screen->neverShared = FALSE;
    screen->dontDisconnect = TRUE;
    screen->authPasswdData = passwords;
    screen->passwordCheck = rfbCheckPasswordByList;
    screen->port = 0;
    screen->ipv6port = 0;
    screen->httpPort = 0;
    screen->udpPort = 0;
    screen->autoPort = FALSE;
    screen->listenInterface = htonl(INADDR_LOOPBACK);
    screen->deferUpdateTime = 0;
    screen->maxClientWait = 1000;
    screen->newClientHook = connected;
    screen->ptrAddEvent = pointer;
    screen->kbdAddEvent = key;
    screen->setXCutText = no_clipboard;
    screen->displayHook = lossless;
    screen->permitFileTransfer = FALSE;
    rfbInitServer(screen);
    // Use an OS-assigned port without the reserve-close-rebind race.
    screen->listenSock = rfbListenOnTCPPort(0, htonl(INADDR_LOOPBACK));
    if (screen->listenSock == RFB_INVALID_SOCKET) return 1;
    FD_SET(screen->listenSock, &screen->allFds);
    screen->maxFd = screen->listenSock;
    struct sockaddr_in address;
    socklen_t address_size = sizeof(address);
    if (getsockname(screen->listenSock, (struct sockaddr *)&address, &address_size)) return 1;
    printf("{\"type\":\"ready\",\"port\":%u}\n", ntohs(address.sin_port));
    if (fcntl(STDIN_FILENO, F_SETFL, O_NONBLOCK) < 0) return 1;
    unsigned char header[4];
    size_t header_size = 0, expected = 0, received = 0;
    unsigned char *png = NULL;
    unsigned frame = 0;
    while (!stopping) {
        rfbProcessEvents(screen, 10000);
        if (client && !announced && client->state == RFB_NORMAL) {
            announced = 1;
            printf("{\"type\":\"connect\",\"client\":%u}\n", client_id);
        }
        for (;;) {
            void *destination = expected ? png + received : header + header_size;
            size_t remaining = expected ? expected - received : 4 - header_size;
            ssize_t count = read(STDIN_FILENO, destination, remaining);
            if (count == 0) { stopping = 1; break; }
            if (count < 0) {
                if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) stopping = 1;
                break;
            }
            if (!expected) {
                header_size += count;
                if (header_size != 4) continue;
                uint32_t length;
                memcpy(&length, header, 4);
                expected = ntohl(length);
                if (!expected || expected > MAX_PNG) { stopping = 1; break; }
                png = malloc(expected);
                if (!png) { stopping = 1; break; }
                received = 0;
            } else {
                received += count;
                if (received != expected) continue;
                if (!decode(screen, png, expected)) {
                    fprintf(stderr, "Invalid Chromium PNG frame\n");
                    stopping = 1;
                    break;
                }
                free(png);
                png = NULL;
                expected = received = header_size = 0;
                printf("{\"type\":\"frame\",\"sequence\":%u}\n", ++frame);
            }
        }
    }
    free(png);
    rfbShutdownServer(screen, TRUE);
    free(screen->frameBuffer);
    screen->frameBuffer = NULL;
    rfbScreenCleanup(screen);
    return 0;
}
