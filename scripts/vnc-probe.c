/* SPDX-License-Identifier: GPL-2.0-or-later
 * Local acceptance probe using the real LibVNCClient decoder. No desktop UI.
 */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <png.h>
#include <rfb/rfbclient.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t stopping;
static char password[9];
static unsigned frames;
static void stop(int value) { (void)value; stopping = 1; }
static char *get_password(rfbClient *client) { (void)client; return strdup(password); }
static void frame(rfbClient *client) {
    uint64_t hash = UINT64_C(14695981039346656037);
    size_t length = (size_t)client->width * client->height * 4;
    for (size_t i = 0; i < length; i++) hash = (hash ^ client->frameBuffer[i]) * UINT64_C(1099511628211);
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    printf("{\"type\":\"frame\",\"frame\":%u,\"hash\":\"%016" PRIx64 "\",\"time\":%.3f,\"width\":%d,\"height\":%d}\n",
           ++frames, hash, now.tv_sec * 1000.0 + now.tv_nsec / 1000000.0, client->width, client->height);
}
static int snapshot(rfbClient *client, const char *path) {
    if (!frames) return 0;
    size_t length = (size_t)client->width * client->height * 4;
    unsigned char *pixels = malloc(length);
    if (!pixels) return 0;
    memcpy(pixels, client->frameBuffer, length);
    for (size_t i = 3; i < length; i += 4) pixels[i] = 255;
    png_image image;
    memset(&image, 0, sizeof(image));
    image.version = PNG_IMAGE_VERSION;
    image.width = client->width;
    image.height = client->height;
    image.format = PNG_FORMAT_RGBA;
    int ok = png_image_write_to_file(&image, path, 0, pixels, 0, NULL);
    free(pixels);
    return ok;
}
int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IOLBF, 0);
    signal(SIGINT, stop); signal(SIGTERM, stop);
    size_t got = 0;
    while (got < 8) {
        ssize_t count = read(STDIN_FILENO, password + got, 8 - got);
        if (count <= 0) return 1;
        got += count;
    }
    rfbClient *client = rfbGetClient(8, 3, 4);
    if (!client) return 1;
    client->format.redShift = 0;
    client->format.greenShift = 8;
    client->format.blueShift = 16;
    client->format.bigEndian = FALSE;
    client->appData.encodingsString = "tight zrle raw";
    client->appData.useRemoteCursor = TRUE;
    client->GetPassword = get_password;
    client->FinishedFrameBufferUpdate = frame;
    client->connectTimeout = 5;
    client->readTimeout = 5;
    if (!rfbInitClient(client, &argc, argv)) return 1;
    printf("{\"type\":\"connected\"}\n");
    fcntl(STDIN_FILENO, F_SETFL, O_NONBLOCK);
    char line[4096];
    size_t used = 0;
    while (!stopping) {
        int ready = WaitForMessage(client, 10000);
        if (ready < 0 || (ready && !HandleRFBServerMessage(client))) break;
        for (;;) {
            char ch;
            ssize_t count = read(STDIN_FILENO, &ch, 1);
            if (count == 0) { stopping = 1; break; }
            if (count < 0) {
                if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) stopping = 1;
                break;
            }
            if (ch != '\n') {
                if (used == sizeof(line) - 1) { stopping = 1; break; }
                line[used++] = ch;
                continue;
            }
            line[used] = 0;
            int x, y, mask, down;
            unsigned sym;
            if (sscanf(line, "pointer %d %d %d", &x, &y, &mask) == 3)
                SendPointerEvent(client, x, y, mask);
            else if (sscanf(line, "key %u %d", &sym, &down) == 2)
                SendKeyEvent(client, sym, down != 0);
            else if (!strncmp(line, "snapshot ", 9))
                printf("{\"type\":\"snapshot\",\"ok\":%s}\n", snapshot(client, line + 9) ? "true" : "false");
            else if (!strcmp(line, "quit")) stopping = 1;
            used = 0;
        }
    }
    free(client->frameBuffer);
    client->frameBuffer = NULL;
    rfbClientCleanup(client);
    return 0;
}
