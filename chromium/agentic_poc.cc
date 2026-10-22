#include "chrome/browser/agentic_poc.h"
#include "chrome/browser/agentic_strings.h"
#include "chrome/browser/agentic_space_controls.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <map>
#include <set>
#include <utility>
#include <vector>

#include "base/check.h"
#include "base/base64.h"
#include "base/command_line.h"
#include "base/containers/span.h"
#include "base/feature_list.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/bind_post_task.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/single_thread_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/threading/sequence_bound.h"
#include "base/threading/thread.h"
#include "base/timer/timer.h"
#include "base/uuid.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_tabstrip.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/tabs/tab_group_model.h"
#include "components/tabs/public/tab_group.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/tabs/tab_strip_model_observer.h"
#include "chrome/browser/ui/ui_features.h"
#include "chrome/browser/ui/window_metadata/window_metadata_controller.h"
#include "components/tab_groups/tab_group_visual_data.h"
#include "components/viz/common/frame_sinks/copy_output_result.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/devtools_agent_host_client.h"
#include "content/public/browser/host_zoom_map.h"
#include "content/public/browser/page.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "net/base/ip_address.h"
#include "net/base/ip_endpoint.h"
#include "net/log/net_log_source.h"
#include "net/server/http_server.h"
#include "net/server/http_server_request_info.h"
#include "net/server/http_server_response_info.h"
#include "net/socket/tcp_server_socket.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "third_party/blink/public/common/input/web_input_event.h"
#include "third_party/blink/public/common/page/page_zoom.h"
#include "third_party/skia/include/core/SkCanvas.h"
#include "ui/base/base_window.h"
#include "ui/gfx/codec/png_codec.h"

namespace {
using Reply = base::OnceCallback<void(int, std::string)>;
using Alive = std::shared_ptr<std::atomic_bool>;
using Dispatch =
    base::RepeatingCallback<void(net::HttpServerRequestInfo, Alive, Reply)>;

std::string Nonce() {
  return base::Uuid::GenerateRandomV4().AsLowercaseString();
}

void Respond(Reply reply, int status, base::DictValue value) {
  std::move(reply).Run(status, base::WriteJson(value).value());
}

void Reject(Reply reply, int status, const char* reason) {
  base::DictValue result;
  result.Set("error", reason);
  Respond(std::move(reply), status, std::move(result));
}

// Socket work stays on its own IO thread; browser access stays on the UI
// thread.
class LocalServer : public net::HttpServer::Delegate {
 public:
  explicit LocalServer(Dispatch dispatch) : dispatch_(std::move(dispatch)) {}
  void Start(base::OnceCallback<void(int)> ready) {
    auto socket =
        std::make_unique<net::TCPServerSocket>(nullptr, net::NetLogSource());
    if (socket->Listen(net::IPEndPoint(net::IPAddress::IPv4Localhost(), 0), 8,
                       std::nullopt) != 0) {
      std::move(ready).Run(0);
      return;
    }
    server_ = std::make_unique<net::HttpServer>(std::move(socket), this);
    net::IPEndPoint address;
    server_->GetLocalAddress(&address);
    std::move(ready).Run(address.port());
  }
  void OnConnect(int id) override {
    alive_[id] = std::make_shared<std::atomic_bool>(true);
    server_->SetReceiveBufferSize(id, 32768);
    // A lossless 1280x720 PNG plus JSON/base64 can exceed the default 1 MiB.
    server_->SetSendBufferSize(id, 8 * 1024 * 1024);
  }
  void OnHttpRequest(int id,
                     const net::HttpServerRequestInfo& request) override {
    dispatch_.Run(
        request, alive_.at(id),
        base::BindPostTask(
            base::SingleThreadTaskRunner::GetCurrentDefault(),
            base::BindOnce(&LocalServer::Send, weak_.GetWeakPtr(), id)));
  }
  void OnClose(int id) override {
    auto it = alive_.find(id);
    if (it != alive_.end()) {
      it->second->store(false);
      alive_.erase(it);
    }
  }
  void OnWebSocketRequest(int id, const net::HttpServerRequestInfo&) override {
    server_->Close(id);
  }
  void OnWebSocketMessage(int id, std::string) override { server_->Close(id); }

 private:
  void Send(int id, int status, std::string body) {
    if (!alive_.contains(id)) {
      return;
    }
    static constexpr auto annotation =
        net::DefineNetworkTrafficAnnotation("agentic_poc_local_control", R"(
        semantics {
          sender: "AgenticBrowser PoC"
          description: "Replies to explicitly enabled local task Space control."
          trigger: "Local authenticated helper requests an operation."
          data: "Task page metadata and operation result."
          destination: LOCAL
        }
        policy {
          cookies_allowed: NO
          setting: "Only enabled with the agentic-poc command line flag."
          policy_exception_justification: "Local opt-in development PoC."
        })");
    net::HttpServerResponseInfo response(
        static_cast<net::HttpStatusCode>(status));
    response.AddHeader("Cache-Control", "no-store");
    response.AddHeader("X-Content-Type-Options", "nosniff");
    response.SetBody(body, "application/json");
    server_->SendResponse(id, response, annotation);
  }
  Dispatch dispatch_;
  std::map<int, Alive> alive_;
  std::unique_ptr<net::HttpServer> server_;
  base::WeakPtrFactory<LocalServer> weak_{this};
};

// A Space owns multiple tabs independently of their presentation in the strip.
// Tab groups only hide/show the corresponding tabs; they are not authority.
class TaskSpace : public content::DevToolsAgentHostClient {
 public:
  explicit TaskSpace(std::string name)
      : name(std::move(name)), token(this->name == "main" ? "" : Nonce()) {}
  ~TaskSpace() override { Detach(); }
  content::WebContents* Contents() const {
    if (!browser || browser->IsDeleteScheduled()) {
      return nullptr;
    }
    auto* contents = selected.get();
    if (!contents ||
        GlobalBrowserCollection::GetInstance()->FindBrowserWithTab(contents) !=
            browser.get() ||
        !Contains(contents)) {
      return nullptr;
    }
    return contents;
  }
  bool Contains(content::WebContents* contents) const {
    return contents &&
           std::ranges::any_of(members, [contents](const auto& tab) {
             return tab.get() == contents;
           });
  }
  void KeepTaskRendering() {
    if (name == "main")
      return;
    std::erase_if(rendering,
                  [this](const auto& entry) { return !Contains(entry.first); });
    for (const auto& tab : members) {
      if (tab && !rendering.contains(tab.get())) {
        rendering.emplace(tab.get(), tab->IncrementCapturerCount(
                                         gfx::Size(), false, false, false));
      }
    }
  }
  void RefreshInputGuard() {
    guards.clear();
    if (lease.empty() && !awaiting_resume) {
      return;
    }
    for (const auto& tab : members) {
      if (tab) {
        guards.push_back(tab->IgnoreInputEvents(
            base::BindRepeating([](const blink::WebInputEvent& event) {
              return (event.GetModifiers() &
                      blink::WebInputEvent::kFromDebugger) != 0;
            })));
      }
    }
  }
  void Detach() {
    if (host_) {
      host_->DetachClient(this);
    }
    host_.reset();
  }
  bool Attach(content::WebContents* contents) {
    auto host = content::DevToolsAgentHost::GetOrCreateFor(contents);
    if (host_ == host) {
      return true;
    }
    Detach();
    if (!host->AttachClient(this)) {
      return false;
    }
    host_ = std::move(host);
    return true;
  }
  void Send(const char* method, base::DictValue params) {
    base::DictValue message;
    message.Set("id", ++sequence_);
    message.Set("method", method);
    message.Set("params", std::move(params));
    const auto json = base::WriteJson(message).value();
    host_->DispatchProtocolMessage(this, base::as_byte_span(json));
  }
  // Revoke held remote input before changing ownership, even if its socket died.
  void ReleaseRemoteInput() {
    if (host_) {
      for (const auto& [keysym, params] : held_keys) {
        auto up = params.Clone();
        up.Set("type", "keyUp");
        up.Remove("text");
        Send("Input.dispatchKeyEvent", std::move(up));
      }
      for (const auto& [bit, button] :
           {std::pair{1, "left"}, {2, "middle"}, {4, "right"}}) {
        if (!(pointer_mask & bit))
          continue;
        base::DictValue up;
        up.Set("type", "mouseReleased");
        up.Set("button", button);
        up.Set("buttons", 0);
        up.Set("x", pointer_x);
        up.Set("y", pointer_y);
        up.Set("clickCount", 1);
        Send("Input.dispatchMouseEvent", std::move(up));
      }
    }
    held_keys.clear();
    pointer_mask = 0;
  }
  // Input replies carry no page data. The caller verifies effects by observing
  // the page; the response below deliberately says dispatched, not completed.
  void DispatchProtocolMessage(content::DevToolsAgentHost*,
                               base::span<const uint8_t>) override {}
  void AgentHostClosed(content::DevToolsAgentHost*) override { host_.reset(); }
  bool MayAttachToURL(const GURL& url, bool is_webui) override {
    return !is_webui && url.SchemeIsHTTPOrHTTPS();
  }
  bool IsTrusted() override { return false; }
  bool MayReadLocalFiles() override { return false; }
  bool MayWriteLocalFiles() override { return false; }
  bool AllowUnsafeOperations() override { return false; }

  bool closed = false;
  bool closing = false;
  const std::string name;
  const std::string token;
  base::WeakPtr<BrowserWindowInterface> browser;
  std::vector<base::WeakPtr<content::WebContents>> members;
  base::WeakPtr<content::WebContents> selected;
  std::optional<tab_groups::TabGroupId> group;
  std::vector<content::WebContents::ScopedIgnoreInputEvents> guards;
  std::map<content::WebContents*, base::ScopedClosureRunner> rendering;
  std::string lease;
  std::string previous_lease;
  bool human = false;
  bool awaiting_resume = false;
  bool needs_observation = false;
  int generation = 1;
  const std::string vnc_token = name == "task-b" ? Nonce() : "";
  std::map<std::string, base::TimeTicks> viewers;
  std::string remote_client;
  bool streaming = false;
  bool capturing = false;
  base::TimeTicks stream_seen;
  base::WeakPtr<content::WebContents> streamed_contents;
  base::ScopedClosureRunner stream_capture;
  int viewport_version = 0;
  struct Frame {
    base::TimeTicks time;
    std::string tab;
    std::string url;
    int generation;
    int viewport_version;
    gfx::Size view_size;
    gfx::Rect content_rect;
    double css_scale;
  };
  std::map<std::string, Frame> frames;
  std::map<int, base::DictValue> held_keys;
  int pointer_mask = 0;
  double pointer_x = 0;
  double pointer_y = 0;
  gfx::Size last_view_size;
  double last_css_scale = 0;

 private:
  scoped_refptr<content::DevToolsAgentHost> host_;
  int sequence_ = 0;
};

class PocParts : public ChromeBrowserMainExtraParts,
                 public TabStripModelObserver {
 public:
  PocParts() {
    for (const char* name : {"main", "task-a", "task-b"})
      spaces_.push_back(std::make_unique<TaskSpace>(name));
  }
  void PreEarlyInitialization() override {
    const auto* command = base::CommandLine::ForCurrentProcess();
    // No public/raw CDP endpoint is permitted in this mode.
    CHECK(!command->HasSwitch("remote-debugging-port"));
    CHECK(!command->HasSwitch("remote-debugging-pipe"));
  }
  void PostBrowserStart() override {
    const auto* command = base::CommandLine::ForCurrentProcess();
    const auto profile_dir = command->GetSwitchValuePath("user-data-dir");
    CHECK(!profile_dir.empty());
    discovery_ = profile_dir.AppendASCII("agentic-poc.json");
    files_ = base::ThreadPool::CreateSequencedTaskRunner(
        {base::MayBlock(), base::TaskShutdownBehavior::BLOCK_SHUTDOWN});
    BrowserWindowInterface* main = nullptr;
    GlobalBrowserCollection::GetInstance()->ForEach(
        [&](BrowserWindowInterface* browser) {
          if (browser->GetType() == BrowserWindowInterface::TYPE_NORMAL &&
              !browser->GetProfile()->IsOffTheRecord()) {
            main = browser;
            return false;
          }
          return true;
        });
    CHECK(main);
    CHECK(base::FeatureList::IsEnabled(features::kTabGroupsFocusing));
    browser_ = main->GetWeakPtr();
    auto* model = main->GetTabStripModel();
    for (auto& space : spaces_) {
      space->browser = browser_;
    }
    for (int i = 0; i < model->count(); ++i) {
      spaces_[0]->members.push_back(model->GetWebContentsAt(i)->GetWeakPtr());
    }
    spaces_[0]->selected = model->GetActiveWebContents()->GetWeakPtr();
    spaces_[0]->human = true;
    for (size_t i = 1; i < spaces_.size(); ++i) {
      const GURL url(command->GetSwitchValueASCII("agentic-poc-" +
                                                  spaces_[i]->name + "-url"));
      CHECK(url.SchemeIsHTTPOrHTTPS());
      auto* tab = chrome::AddAndReturnTabAt(main, url, -1, false);
      spaces_[i]->members.push_back(tab->GetWeakPtr());
      spaces_[i]->selected = tab->GetWeakPtr();
    }
    controls_ = AddAgenticSpaceControls(
        main, base::BindRepeating(&PocParts::HumanAction, weak_.GetWeakPtr()));
    model->AddObserver(this);
    closed_ = main->RegisterBrowserDidClose(
        base::BindRepeating(&PocParts::BrowserClosed, weak_.GetWeakPtr()));
    Reconcile();
    base::Thread::Options options;
    options.message_pump_type = base::MessagePumpType::IO;
    CHECK(io_.StartWithOptions(std::move(options)));
    server_ = base::SequenceBound<LocalServer>(
        io_.task_runner(),
        base::BindPostTask(
            base::SingleThreadTaskRunner::GetCurrentDefault(),
            base::BindRepeating(&PocParts::Handle, weak_.GetWeakPtr())));
    server_.AsyncCall(&LocalServer::Start)
        .WithArgs(base::BindPostTask(
            base::SingleThreadTaskRunner::GetCurrentDefault(),
            base::BindOnce(&PocParts::ServerReady, weak_.GetWeakPtr())));
  }
  void PostMainMessageLoopRun() override {
    remote_timer_.Stop();
    weak_.InvalidateWeakPtrs();
    for (auto& space : spaces_) {
      space->ReleaseRemoteInput();
      space->stream_capture.RunAndReset();
      space->Detach();
      space->guards.clear();
      space->rendering.clear();
    }
    if (browser_) {
      browser_->GetTabStripModel()->RemoveObserver(this);
    }
    if (!server_.is_null()) {
      server_.Reset();
      io_.Stop();
    }
    // This file only contains ephemeral capabilities for this run.
    if (files_) {
      files_->PostTask(
          FROM_HERE,
          base::BindOnce([](base::FilePath path) { base::DeleteFile(path); },
                         discovery_));
    }
  }

 private:
  void BrowserClosed(BrowserWindowInterface* browser) {
    browser->GetTabStripModel()->RemoveObserver(this);
    for (auto& space : spaces_) {
      space->Detach();
      space->guards.clear();
      space->rendering.clear();
      space->browser.reset();
    }
    browser_.reset();
  }
  int SpaceFor(content::WebContents* contents) const {
    for (size_t i = 0; i < spaces_.size(); ++i) {
      if (spaces_[i]->Contains(contents))
        return i;
    }
    return -1;
  }
  void ScheduleReconcile() {
    if (reconciling_ || reconcile_pending_)
      return;
    reconcile_pending_ = true;
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&PocParts::Reconcile, weak_.GetWeakPtr()));
  }
  void OnTabStripModelChanged(TabStripModel* model,
                              const TabStripModelChange& change,
                              const TabStripSelectionChange&) override {
    if (reconciling_)
      return;
    if (change.type() == TabStripModelChange::kInserted) {
      for (const auto& item : change.GetInsert()->contents) {
        int owner = visible_space_;
        auto* opener =
            item.contents->GetFirstWebContentsInLiveOriginalOpenerChain();
        if (const int found = SpaceFor(opener); found >= 0)
          owner = found;
        if (SpaceFor(item.contents) < 0)
          spaces_[owner]->members.push_back(item.contents->GetWeakPtr());
      }
    } else if (change.type() == TabStripModelChange::kReplaced) {
      const auto* replaced = change.GetReplace();
      if (int owner = SpaceFor(replaced->old_contents); owner >= 0) {
        auto& space = *spaces_[owner];
        for (auto& tab : space.members)
          if (tab.get() == replaced->old_contents)
            tab = replaced->new_contents->GetWeakPtr();
        if (space.selected.get() == replaced->old_contents)
          space.selected = replaced->new_contents->GetWeakPtr();
      }
    }
    auto* active = model->GetActiveWebContents();
    if (int owner = SpaceFor(active); owner >= 0) {
      // Only the Space controls change the visible workspace. A background
      // page may open an active tab; remember it without switching the user.
      spaces_[owner]->selected = active->GetWeakPtr();
    }
    ScheduleReconcile();
  }
  void OnTabChangedAt(tabs::TabInterface*, TabChangeType) override {
    if (!reconciling_)
      RefreshControls();
  }
  void OnTabPinnedStateChanged(tabs::TabInterface*, int) override {
    ScheduleReconcile();
  }
  void TabGroupedStateChanged(TabStripModel*,
                              std::optional<tab_groups::TabGroupId>,
                              std::optional<tab_groups::TabGroupId>,
                              tabs::TabInterface*,
                              int) override {
    ScheduleReconcile();
  }
  void OnTabGroupChanged(const TabGroupChange&) override {
    ScheduleReconcile();
  }

  void Reconcile() {
    reconcile_pending_ = false;
    if (!browser_ || browser_->IsDeleteScheduled() || reconciling_)
      return;
    reconciling_ = true;
    auto* model = browser_->GetTabStripModel();
    // Space owns membership. Pinning/regrouping is not a separate PoC mode.
    for (auto& space : spaces_) {
      if (space->closed)
        continue;
      std::erase_if(space->members, [model](const auto& tab) {
        return !tab || model->GetIndexOfWebContents(tab.get()) < 0;
      });
      if (space->closing) {
        if (space->members.empty()) {
          space->closed = true;
          space->closing = false;
          space->Detach();
          space->guards.clear();
          space->rendering.clear();
          space->selected.reset();
          WriteDiscovery();
          continue;
        }
        // Chromium owns beforeunload confirmation. A cancelled group close
        // leaves its surviving tabs ungrouped; keep that workspace intact.
        if (space->group && model->group_model()->ContainsTabGroup(*space->group) &&
            model->group_model()->GetTabGroup(*space->group)->IsGroupClosing())
          continue;
        space->closing = false;
      }
      if (space->members.empty()) {
        auto* tab = chrome::AddAndReturnTabAt(browser_.get(),
                                            GURL("about:blank"), -1, false);
        space->members.push_back(tab->GetWeakPtr());
      }
      if (!space->Contains(space->selected.get()))
        space->selected = space->members.front();
      for (const auto& tab : space->members) {
        int index = model->GetIndexOfWebContents(tab.get());
        if (model->IsTabPinned(index))
          model->SetTabPinned(index, false);
      }
      std::vector<int> indices;
      for (const auto& tab : space->members)
        indices.push_back(model->GetIndexOfWebContents(tab.get()));
      std::ranges::sort(indices);
      if (!space->group ||
          !model->group_model()->ContainsTabGroup(*space->group)) {
        space->group = model->AddToNewGroup(indices);
      } else {
        std::erase_if(indices, [&](int index) {
          return model->GetTabGroupForTab(index) == space->group;
        });
        if (!indices.empty())
          model->AddToExistingGroup(indices, *space->group);
      }
      const auto title = SpaceName(SpaceFor(space->selected.get()));
      model->ChangeTabGroupVisuals(
          *space->group, tab_groups::TabGroupVisualData(
                             title, tab_groups::TabGroupColorId::kBlue));
      space->RefreshInputGuard();
      space->KeepTaskRendering();
      if (space->streaming)
        ConfigureStream(*space);
    }
    auto& shown = *spaces_[visible_space_];
    model->EnterFocusMode(*shown.group);
    model->ActivateTabAt(model->GetIndexOfWebContents(shown.selected.get()));
    reconciling_ = false;
    RefreshControls();
  }
  void RefreshControls() {
    if (!browser_ || controls_.is_null())
      return;
    std::vector<AgenticSpacePresentation> presentation;
    for (size_t i = 0; i < spaces_.size(); ++i) {
      const auto& space = *spaces_[i];
      if (space.closed)
        continue;
      auto& ui = presentation.emplace_back();
      ui.id = i;
      ui.name = SpaceName(i);
      ui.can_close = CanClose(i);
      ui.viewers = static_cast<int>(space.viewers.size());
      ui.owner = !space.remote_client.empty() ? AgenticSpaceOwner::kRemote
                 : space.human ? AgenticSpaceOwner::kHuman
                 : space.awaiting_resume ? AgenticSpaceOwner::kAwaitingResume
                 : space.lease.empty() ? AgenticSpaceOwner::kAvailable
                                       : AgenticSpaceOwner::kAgent;
      ui.status = i == 0 ? AgenticText("human_only")
                  : !space.remote_client.empty() ? AgenticText("remote_control")
                  : space.human ? AgenticText("human_control")
                  : space.awaiting_resume ? AgenticText("await_resume")
                  : space.lease.empty() ? AgenticText("available")
                                        : AgenticText("agent_control");
      if (i != 0 && !space.viewers.empty() && space.remote_client.empty())
        ui.status += AgenticText("viewing_suffix");
      ui.contents = space.selected;
      ui.can_return = space.human && !space.previous_lease.empty();
      for (const auto& tab : space.members) {
        if (!tab)
          continue;
        if (tab.get() == space.selected.get())
          ui.selected_tab = static_cast<int>(ui.tabs.size());
        ui.tabs.push_back(tab->GetTitle().empty() ? AgenticText("new_tab")
                                                 : tab->GetTitle());
      }
    }
    controls_.Run(visible_space_, presentation);
    const auto shown = std::ranges::find(presentation, visible_space_,
                                         &AgenticSpacePresentation::id);
    WindowMetadataController::From(browser_.get())->SetWindowUserTitle(
        base::UTF16ToUTF8(shown->name + u" · " + shown->status));
  }
  void TakeHuman(TaskSpace& space) {
    space.ReleaseRemoteInput();
    if (!space.lease.empty() && space.remote_client.empty())
      space.previous_lease = space.lease;
    space.remote_client.clear();
    space.lease.clear();
    space.human = true;
    space.awaiting_resume = false;
    space.needs_observation = false;
    ++space.generation;
    if (!space.streaming)
      space.Detach();
    space.RefreshInputGuard();
    RefreshControls();
  }
  std::u16string SpaceName(int id) const {
    if (id == 0)
      return AgenticText("main");
    return base::NumberToString16(id) + u" · " +
        (id == 1 ? AgenticText("space_a") : id == 2 ? AgenticText("space_b") : AgenticText("space"));
  }
  bool CanClose(int id) const {
    const auto& space = *spaces_[id];
    return id != 0 && !space.closed && !space.closing &&
        space.lease.empty() && space.previous_lease.empty() &&
        !space.awaiting_resume && space.viewers.empty() &&
        space.remote_client.empty();
  }
  void HumanAction(AgenticSpaceCommand action, int id) {
    if (!browser_ || browser_->IsDeleteScheduled())
      return;
    if (action == AgenticSpaceCommand::kCreate) {
      // IDs are never reused: a closed workspace's credentials cannot address
      // a later workspace. All tabs still use this browser's shared Profile.
      const int next = spaces_.size();
      auto space = std::make_unique<TaskSpace>("task-" + base::NumberToString(next + 1));
      space->browser = browser_;
      spaces_.push_back(std::move(space));
      visible_space_ = next;
      Reconcile();
      WriteDiscovery();
    } else if (action == AgenticSpaceCommand::kClose) {
      if (id <= 0 || id >= static_cast<int>(spaces_.size()) || !CanClose(id))
        return;
      auto& space = *spaces_[id];
      if (!space.group)
        return;
      space.closing = true;
      if (visible_space_ == id)
        visible_space_ = 0;
      // Use Chromium's normal close path, including beforeunload and history.
      browser_->GetTabStripModel()->CloseAllTabsInGroup(*space.group);
      ScheduleReconcile();
    } else if (action == AgenticSpaceCommand::kSelect) {
      if (id < 0 || id >= static_cast<int>(spaces_.size()) ||
          spaces_[id]->closed || spaces_[id]->closing)
        return;
      visible_space_ = id;
      Reconcile();
    } else if (visible_space_ != 0) {
      auto& space = *spaces_[visible_space_];
      if (action == AgenticSpaceCommand::kTake)
        TakeHuman(space);
      if (action == AgenticSpaceCommand::kReturn && space.human) {
        space.human = false;
        space.awaiting_resume = !space.previous_lease.empty();
        ++space.generation;
        space.RefreshInputGuard();
        RefreshControls();
      }
    }
  }
  void ServerReady(int port) {
    CHECK(port);
    port_ = port;
    WriteDiscovery();
    remote_timer_.Start(FROM_HERE, base::Seconds(1), this,
                        &PocParts::ExpireRemote);
  }
  void WriteDiscovery() {
    if (!port_ || !browser_) {
      return;
    }
    base::DictValue result;
    result.Set("port", port_);
    base::DictValue tasks;
    for (auto& space : spaces_) {
      if (space->name != "main" && !space->closed)
        tasks.Set(space->name, space->token);
    }
    result.Set("tasks", std::move(tasks));
    base::DictValue vnc;
    vnc.Set("task-b", spaces_[2]->vnc_token);
    result.Set("vnc", std::move(vnc));
    files_->PostTask(FROM_HERE,
                     base::BindOnce(
                         [](base::FilePath path, std::string json) {
                           CHECK(base::WriteFile(path, json));
                           CHECK(base::SetPosixFilePermissions(path, 0600));
                         },
                         discovery_, base::WriteJson(result).value()));
  }
  static double CssScale(content::WebContents* contents) {
    return blink::ZoomLevelToZoomFactor(content::HostZoomMap::GetZoomLevel(contents));
  }
  void ConfigureStream(TaskSpace& space) {
    auto* contents = space.Contents();
    if (!contents || contents == space.streamed_contents.get())
      return;
    // RFB input has no displayed-frame ID. Changing target requires a fresh
    // explicit takeover, so delayed old coordinates cannot control a new tab.
    ReturnRemote(space);
    space.ReleaseRemoteInput();
    space.stream_capture.RunAndReset();
    space.streamed_contents = contents->GetWeakPtr();
    // Keep this very WebContents alive, not a second headless browser. Empty
    // preferred size preserves the exact viewport used by the local browser.
    space.stream_capture = contents->IncrementCapturerCount(
        gfx::Size(), false, false, true);
    space.frames.clear();
    ++space.viewport_version;
    RefreshControls();
  }
  void ReturnRemote(TaskSpace& space) {
    if (space.remote_client.empty())
      return;
    space.ReleaseRemoteInput();
    space.remote_client.clear();
    space.lease.clear();
    space.human = false;
    space.awaiting_resume = !space.previous_lease.empty();
    space.needs_observation = false;
    ++space.generation;
    space.frames.clear();
    space.RefreshInputGuard();
  }
  void StopStream(TaskSpace& space) {
    ReturnRemote(space);
    space.viewers.clear();
    space.streaming = false;
    space.stream_capture.RunAndReset();
    space.streamed_contents.reset();
    space.frames.clear();
    ++space.viewport_version;
    RefreshControls();
  }
  void ExpireRemote() {
    auto& space = *spaces_[2];
    if (space.closed)
      return;
    const auto now = base::TimeTicks::Now();
    bool changed = false;
    for (auto it = space.viewers.begin(); it != space.viewers.end();) {
      if (now - it->second > base::Seconds(5)) {
        if (space.remote_client == it->first)
          ReturnRemote(space);
        it = space.viewers.erase(it);
        changed = true;
      } else {
        ++it;
      }
    }
    if (space.streaming && now - space.stream_seen > base::Seconds(5))
      StopStream(space);
    else if (changed)
      RefreshControls();
  }
  void CaptureFrame(TaskSpace& space, Alive alive, Reply reply) {
    auto* contents = space.Contents();
    auto* view = contents ? contents->GetRenderWidgetHostView() : nullptr;
    if (!space.streaming || space.capturing || !view ||
        !view->IsSurfaceAvailableForCopy() ||
        !contents->GetLastCommittedURL().SchemeIsHTTPOrHTTPS()) {
      Reject(std::move(reply), 409, "frame_unavailable");
      return;
    }
    ConfigureStream(space);
    const gfx::Size size = view->GetViewBounds().size();
    const double css_scale = CssScale(contents);
    if (size.IsEmpty() || css_scale <= 0) {
      Reject(std::move(reply), 409, "viewport_unavailable");
      return;
    }
    if (space.last_view_size != size || space.last_css_scale != css_scale) {
      ReturnRemote(space);
      ++space.viewport_version;
      space.frames.clear();
      space.ReleaseRemoteInput();
      space.last_view_size = size;
      space.last_css_scale = css_scale;
      RefreshControls();
    }
    const double ratio = std::min(1280.0 / size.width(), 720.0 / size.height());
    const gfx::Size output(std::max(1, static_cast<int>(size.width() * ratio)),
                           std::max(1, static_cast<int>(size.height() * ratio)));
    TaskSpace::Frame meta{
        base::TimeTicks::Now(),
        content::DevToolsAgentHost::GetOrCreateFor(contents)->GetId(),
        contents->GetLastCommittedURL().spec(), space.generation,
        space.viewport_version, size,
        gfx::Rect((1280 - output.width()) / 2, (720 - output.height()) / 2,
                  output.width(), output.height()), css_scale};
    space.capturing = true;
    space.stream_seen = base::TimeTicks::Now();
    view->CopyFromSurface(
        gfx::Rect(), output, base::Milliseconds(800),
        base::BindPostTaskToCurrentDefault(base::BindOnce(
            &PocParts::FrameCopied, weak_.GetWeakPtr(), std::move(meta),
            std::move(alive), std::move(reply))));
  }
  void FrameCopied(TaskSpace::Frame meta, Alive alive, Reply reply,
                   const content::CopyFromSurfaceResult& result) {
    auto& space = *spaces_[2];
    if (!result.has_value() || result->bitmap.drawsNothing()) {
      space.capturing = false;
      Reject(std::move(reply), 409, "capture_failed");
      return;
    }
    SkBitmap bitmap = result->bitmap;
    bitmap.setImmutable();
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, {base::TaskPriority::USER_VISIBLE},
        base::BindOnce([](SkBitmap source, gfx::Rect rect) {
          SkBitmap output;
          output.allocN32Pixels(1280, 720);
          SkCanvas canvas(output);
          canvas.clear(SkColorSetRGB(18, 22, 30));
          canvas.writePixels(source, rect.x(), rect.y());
          const auto png = gfx::PNGCodec::FastEncodeBGRASkBitmap(output, true);
          return png ? base::Base64Encode(*png) : std::string();
        }, std::move(bitmap), meta.content_rect),
        base::BindOnce(&PocParts::FrameEncoded, weak_.GetWeakPtr(),
                        std::move(meta), std::move(alive), std::move(reply)));
  }
  void FrameEncoded(TaskSpace::Frame meta, Alive alive, Reply reply,
                    std::string png) {
    auto& space = *spaces_[2];
    space.capturing = false;
    auto* contents = space.Contents();
    if (!alive->load())
      return;
    if (png.empty() || !space.streaming || !contents ||
        meta.generation != space.generation ||
        meta.viewport_version != space.viewport_version ||
        meta.url != contents->GetLastCommittedURL().spec() ||
        meta.tab != content::DevToolsAgentHost::GetOrCreateFor(contents)->GetId()) {
      Reject(std::move(reply), 409, "frame_changed");
      return;
    }
    std::erase_if(space.frames, [](const auto& entry) {
      return base::TimeTicks::Now() - entry.second.time > base::Milliseconds(1500);
    });
    const std::string id = Nonce();
    space.frames.emplace(id, meta);
    base::DictValue result;
    result.Set("png", std::move(png));
    result.Set("frame", id);
    result.Set("width", 1280);
    result.Set("height", 720);
    result.Set("tab", meta.tab);
    result.Set("generation", meta.generation);
    result.Set("viewportVersion", meta.viewport_version);
    result.Set("cssWidth", meta.view_size.width() / meta.css_scale);
    result.Set("cssHeight", meta.view_size.height() / meta.css_scale);
    base::DictValue rect;
    rect.Set("x", meta.content_rect.x()); rect.Set("y", meta.content_rect.y());
    rect.Set("width", meta.content_rect.width());
    rect.Set("height", meta.content_rect.height());
    result.Set("contentRect", std::move(rect));
    Respond(std::move(reply), 200, std::move(result));
  }
  bool RemoteInput(TaskSpace& space, const base::DictValue& data,
                    const std::string& action, Reply& reply) {
    const auto* client = data.FindString("client");
    const auto* frame = data.FindString("frame");
    const auto found = frame ? space.frames.find(*frame) : space.frames.end();
    auto* contents = space.Contents();
    auto* view = contents ? contents->GetRenderWidgetHostView() : nullptr;
    if (!client || *client != space.remote_client || !space.viewers.contains(*client) ||
        found == space.frames.end() || !view) {
      space.ReleaseRemoteInput();
      Reject(std::move(reply), 409, "remote_or_frame_unavailable");
      return false;
    }
    const auto& meta = found->second;
    // Desktop browser zoom is mapped below. Pinch changes the visual viewport
    // independently; reject its input rather than dispatch an ambiguous point.
    if (!contents->GetPrimaryPage().IsPageScaleFactorOne()) {
      space.ReleaseRemoteInput();
      Reject(std::move(reply), 409, "pinch_zoom_input_unavailable");
      return false;
    }
    if (base::TimeTicks::Now() - meta.time > base::Milliseconds(1500) ||
        meta.generation != space.generation ||
        data.FindInt("viewportVersion") != meta.viewport_version ||
        meta.viewport_version != space.viewport_version ||
        meta.view_size != view->GetViewBounds().size() ||
        meta.css_scale != CssScale(contents) ||
        meta.url != contents->GetLastCommittedURL().spec() ||
        meta.tab != content::DevToolsAgentHost::GetOrCreateFor(contents)->GetId()) {
      space.ReleaseRemoteInput();
      Reject(std::move(reply), 409, "stale_frame");
      return false;
    }
    if (!space.Attach(contents)) {
      Reject(std::move(reply), 409, "target_busy");
      return false;
    }
    if (action == "pointer") {
      const auto x = data.FindDouble("x"), y = data.FindDouble("y");
      const auto mask = data.FindInt("mask");
      if (!x || !y || !mask || *mask < 0 || *mask > 255 ||
          !std::isfinite(*x) || !std::isfinite(*y) ||
          !gfx::RectF(meta.content_rect).Contains(gfx::PointF(*x, *y))) {
        space.ReleaseRemoteInput();
        Reject(std::move(reply), 400, "point_outside_content");
        return false;
      }
      space.pointer_x = (*x - meta.content_rect.x()) * meta.view_size.width() /
                         meta.content_rect.width() / meta.css_scale;
      space.pointer_y = (*y - meta.content_rect.y()) * meta.view_size.height() /
                         meta.content_rect.height() / meta.css_scale;
      base::DictValue params;
      params.Set("x", space.pointer_x); params.Set("y", space.pointer_y);
      params.Set("type", "mouseMoved");
      const auto buttons = [](int value) {
        return (value & 1) | ((value & 2) << 1) | ((value & 4) >> 1);
      };
      params.Set("buttons", buttons(*mask));
      params.Set("button", "none");
      space.Send("Input.dispatchMouseEvent", params.Clone());
      for (const auto& [bit, button] :
           {std::pair{1, "left"}, {2, "middle"}, {4, "right"}}) {
        if (!((*mask ^ space.pointer_mask) & bit))
          continue;
        params.Set("type", (*mask & bit) ? "mousePressed" : "mouseReleased");
        params.Set("button", button);
        params.Set("clickCount", 1);
        space.Send("Input.dispatchMouseEvent", params.Clone());
      }
      if (*mask & (8 | 16 | 32 | 64)) {
        params.Set("type", "mouseWheel");
        params.Set("button", "none");
        params.Set("deltaY", (*mask & 8) ? -100 : (*mask & 16) ? 100 : 0);
        params.Set("deltaX", (*mask & 32) ? -100 : (*mask & 64) ? 100 : 0);
        space.Send("Input.dispatchMouseEvent", std::move(params));
      }
      space.pointer_mask = *mask & 7;
    } else {
      const auto keysym = data.FindInt("keysym");
      const auto down = data.FindBool("down");
      if (!keysym || !down) {
        Reject(std::move(reply), 400, "invalid_key");
        return false;
      }
      base::DictValue params;
      const std::map<int, std::pair<const char*, int>> special = {
        {0xff08,{"Backspace",8}}, {0xff09,{"Tab",9}}, {0xff0d,{"Enter",13}},
        {0xff1b,{"Escape",27}}, {0xffff,{"Delete",46}},
        {0xff50,{"Home",36}}, {0xff57,{"End",35}},
        {0xff51,{"ArrowLeft",37}}, {0xff52,{"ArrowUp",38}},
        {0xff53,{"ArrowRight",39}}, {0xff54,{"ArrowDown",40}},
        {0xff55,{"PageUp",33}}, {0xff56,{"PageDown",34}},
        {0xffe1,{"Shift",16}}, {0xffe2,{"Shift",16}},
        {0xffe3,{"Control",17}}, {0xffe4,{"Control",17}},
        {0xffe9,{"Alt",18}}, {0xffea,{"Alt",18}},
        {0xffeb,{"Meta",91}}, {0xffec,{"Meta",91}}};
      const auto key = special.find(*keysym);
      std::string text;
      if (key != special.end()) {
        params.Set("key", key->second.first);
        params.Set("windowsVirtualKeyCode", key->second.second);
        if (*keysym == 0xff0d) text = "\r";
      } else {
        const uint32_t unicode = (*keysym & 0xff000000) == 0x01000000
                                     ? *keysym & 0x00ffffff : *keysym;
        if (unicode < 32 || unicode > 0x10ffff ||
            (unicode >= 0xd800 && unicode <= 0xdfff)) {
          Reject(std::move(reply), 400, "unsupported_key");
          return false;
        }
        std::u16string utf16;
        if (unicode < 0x10000) utf16.push_back(unicode);
        else {
          utf16.push_back(0xd800 + ((unicode - 0x10000) >> 10));
          utf16.push_back(0xdc00 + ((unicode - 0x10000) & 1023));
        }
        text = base::UTF16ToUTF8(utf16);
        params.Set("key", text);
        if (unicode < 128)
          params.Set("windowsVirtualKeyCode", static_cast<int>(unicode >= 'a' && unicode <= 'z' ? unicode - 32 : unicode));
      }
      params.Set("type", *down ? "keyDown" : "keyUp");
      if (*down) space.held_keys.insert_or_assign(*keysym, params.Clone());
      else space.held_keys.erase(*keysym);
      int modifiers = 0;
      for (const auto& [held, ignored] : space.held_keys) {
        if (held == 0xffe1 || held == 0xffe2) modifiers |= 8;
        if (held == 0xffe3 || held == 0xffe4) modifiers |= 2;
        if (held == 0xffe9 || held == 0xffea) modifiers |= 1;
        if (held == 0xffeb || held == 0xffec) modifiers |= 4;
      }
      params.Set("modifiers", modifiers);
      if (*down && !(modifiers & 6) && !text.empty())
        params.Set("text", text);
      space.Send("Input.dispatchKeyEvent", std::move(params));
    }
    return true;
  }
  void Handle(net::HttpServerRequestInfo request, Alive alive, Reply reply) {
    if (!alive->load()) {
      return;
    }
    if (request.method != "POST" || request.path != "/space" ||
        request.headers.contains("origin") || request.data.size() > 16384) {
      Reject(std::move(reply), 403, "unsupported_request");
      return;
    }
    auto data = base::JSONReader::ReadDict(request.data, base::JSON_PARSE_RFC);
    if (!data) {
      Reject(std::move(reply), 400, "invalid_json");
      return;
    }
    const auto* name = data->FindString("space");
    TaskSpace* space = nullptr;
    for (auto& candidate : spaces_) {
      if (name && *name != "main" && *name == candidate->name &&
          !candidate->closed && !candidate->closing) {
        space = candidate.get();
      }
    }
    const auto auth = request.GetHeaderValue("authorization");
    const bool vnc_auth = space && !space->vnc_token.empty() &&
                          auth == "Bearer " + space->vnc_token;
    if (!space || (!vnc_auth && auth != "Bearer " + space->token)) {
      Reject(std::move(reply), 403, "space_not_authorized");
      return;
    }
    const auto* action = data->FindString("action");
    auto* contents = space->Contents();
    if (!action || !contents) {
      Reject(std::move(reply), 409, "space_unavailable");
      return;
    }
    base::DictValue result;
    if (vnc_auth) {
      if (*action == "observe") {
        // Shared read path below; this capability still has no Agent actions.
      } else if (*action == "streamStart") {
        space->streaming = true;
        space->stream_seen = base::TimeTicks::Now();
        ConfigureStream(*space);
        result.Set("width", 1280); result.Set("height", 720);
        Respond(std::move(reply), 200, std::move(result));
        return;
      } else if (*action == "streamStop") {
        StopStream(*space);
        result.Set("stopped", true);
        Respond(std::move(reply), 200, std::move(result));
        return;
      } else if (*action == "frame") {
        CaptureFrame(*space, std::move(alive), std::move(reply));
        return;
      } else if (*action == "vncConnect" || *action == "vncHeartbeat" ||
                 *action == "vncDisconnect" || *action == "vncTake" ||
                 *action == "vncReturn" || *action == "pointer" || *action == "key") {
        const auto* client = data->FindString("client");
        if (!client || client->empty() || client->size() > 80 || !space->streaming) {
          Reject(std::move(reply), 409, "vnc_session_unavailable");
          return;
        }
        if (*action == "vncConnect") {
          if (!space->viewers.empty() && !space->viewers.contains(*client)) {
            Reject(std::move(reply), 409, "viewer_limit");
            return;
          }
          space->viewers[*client] = base::TimeTicks::Now();
        } else if (!space->viewers.contains(*client)) {
          Reject(std::move(reply), 409, "vnc_session_unavailable");
          return;
        } else if (*action == "vncHeartbeat") {
          space->viewers[*client] = base::TimeTicks::Now();
        } else if (*action == "vncDisconnect") {
          if (space->remote_client == *client)
            ReturnRemote(*space);
          space->viewers.erase(*client);
        } else if (*action == "vncTake") {
          if (!space->remote_client.empty()) {
            Reject(std::move(reply), 409, "already_claimed");
            return;
          }
          if (!space->lease.empty())
            space->previous_lease = space->lease;
          space->ReleaseRemoteInput();
          space->lease = Nonce();
          space->remote_client = *client;
          space->human = false;
          space->awaiting_resume = false;
          space->needs_observation = false;
          ++space->generation;
          space->frames.clear();
          space->RefreshInputGuard();
          result.Set("lease", space->lease);
          result.Set("generation", space->generation);
          result.Set("tab", content::DevToolsAgentHost::GetOrCreateFor(contents)->GetId());
        } else {
          const auto* lease = data->FindString("lease");
          if (space->remote_client != *client || !lease || lease->empty() ||
              *lease != space->lease || data->FindInt("generation") != space->generation) {
            Reject(std::move(reply), 409, "stale_control");
            return;
          }
          if (*action == "vncReturn") {
            ReturnRemote(*space);
            result.Set("returned", true);
          } else {
            const auto* tab = data->FindString("tab");
            if (!tab || *tab != content::DevToolsAgentHost::GetOrCreateFor(contents)->GetId() ||
                !contents->GetLastCommittedURL().SchemeIsHTTPOrHTTPS()) {
              Reject(std::move(reply), 403, "wrong_tab");
              return;
            }
            if (!RemoteInput(*space, *data, *action, reply))
              return;
            result.Set("dispatched", true);
          }
        }
        RefreshControls();
        Respond(std::move(reply), 200, std::move(result));
        return;
      } else {
        Reject(std::move(reply), 403, "capability_not_authorized");
        return;
      }
    }
    if (*action == "claim") {
      if (!space->lease.empty() || space->human || space->awaiting_resume) {
        Reject(std::move(reply), 409, "already_claimed");
        return;
      }
      space->lease = Nonce();
      space->needs_observation = false;
      result.Set("lease", space->lease);
      result.Set("generation", ++space->generation);
      space->RefreshInputGuard();
      RefreshControls();
      Respond(std::move(reply), 200, std::move(result));
      return;
    }
    if (*action == "resume") {
      const auto* previous = data->FindString("lease");
      if (!space->awaiting_resume || !previous || previous->empty() ||
          *previous != space->previous_lease) {
        Reject(std::move(reply), 409, "resume_not_authorized");
        return;
      }
      space->awaiting_resume = false;
      space->previous_lease.clear();
      space->lease = Nonce();
      space->needs_observation = true;
      result.Set("lease", space->lease);
      result.Set("generation", ++space->generation);
      space->RefreshInputGuard();
      RefreshControls();
      Respond(std::move(reply), 200, std::move(result));
      return;
    }
    if (*action != "observe") {
      const auto* lease = data->FindString("lease");
      if (!lease || lease->empty() || *lease != space->lease ||
          data->FindInt("generation") != space->generation) {
        Reject(std::move(reply), 409, "stale_control");
        return;
      }
      if (*action == "release") {
        space->lease.clear();
        space->needs_observation = false;
        ++space->generation;
        if (!space->streaming)
          space->Detach();
        space->RefreshInputGuard();
        RefreshControls();
        result.Set("released", true);
        Respond(std::move(reply), 200, std::move(result));
        return;
      }
      if (*action == "handOff") {
        TakeHuman(*space);
        result.Set("handedOff", true);
        Respond(std::move(reply), 200, std::move(result));
        return;
      }
      if (space->needs_observation) {
        Reject(std::move(reply), 409, "observe_before_resuming");
        return;
      }
    }
    if (!contents->GetLastCommittedURL().SchemeIsHTTPOrHTTPS() &&
        !contents->GetLastCommittedURL().IsAboutBlank() &&
        !(*action == "observe" && contents->GetLastCommittedURL().is_empty())) {
      Reject(std::move(reply), 403, "web_page_only");
      return;
    }
    const auto target =
        content::DevToolsAgentHost::GetOrCreateFor(contents)->GetId();
    if (*action == "observe") {
      result.Set("space", space->name);
      result.Set("tab", target);
      result.Set("url", contents->GetLastCommittedURL().spec());
      result.Set("title", base::UTF16ToUTF8(contents->GetTitle()));
      result.Set("windowActive", space->browser->GetWindow()->IsActive());
      result.Set("visible", spaces_[visible_space_].get() == space);
      result.Set("owner", space->human             ? "human"
                          : !space->remote_client.empty() ? "remote"
                          : space->awaiting_resume ? "awaiting-resume"
                          : space->lease.empty()   ? "available"
                                                   : "agent");
      result.Set("tabCount", static_cast<int>(space->members.size()));
      result.Set("generation", space->generation);
      result.Set("viewers", static_cast<int>(space->viewers.size()));
      result.Set("streaming", space->streaming);
      const auto* lease = data->FindString("lease");
      if (lease && !lease->empty() && *lease == space->lease &&
          data->FindInt("generation") == space->generation) {
        space->needs_observation = false;
      }
      Respond(std::move(reply), 200, std::move(result));
      return;
    }
    const auto* tab = data->FindString("tab");
    if (!tab || *tab != target) {
      Reject(std::move(reply), 403, "wrong_tab");
      return;
    }
    if (*action == "navigate") {
      const auto* url_text = data->FindString("url");
      const GURL url(url_text ? *url_text : "");
      if (!url.is_valid() || !url.SchemeIsHTTPOrHTTPS()) {
        Reject(std::move(reply), 400, "invalid_url");
        return;
      }
      contents->GetController().LoadURL(
          url, content::Referrer(), ui::PAGE_TRANSITION_TYPED, std::string());
    } else if (*action == "type" || *action == "click" || *action == "scroll") {
      base::DictValue params;
      if (*action == "type") {
        const auto* text = data->FindString("text");
        if (!text || text->size() > 8192) {
          Reject(std::move(reply), 400, "invalid_text");
          return;
        }
        params.Set("text", *text);
      } else {
        const auto x = data->FindDouble("x"), y = data->FindDouble("y");
        auto* view = contents->GetRenderWidgetHostView();
        if (!x || !y || !view || !std::isfinite(*x) || !std::isfinite(*y) ||
            *x < 0 || *y < 0 || *x >= view->GetViewBounds().width() ||
            *y >= view->GetViewBounds().height()) {
          Reject(std::move(reply), 400, "point_outside_viewport");
          return;
        }
        params.Set("x", *x);
        params.Set("y", *y);
        if (*action == "scroll") {
          const auto delta = data->FindDouble("deltaY");
          if (!delta || !std::isfinite(*delta) || std::abs(*delta) > 5000) {
            Reject(std::move(reply), 400, "invalid_scroll");
            return;
          }
          params.Set("type", "mouseWheel");
          params.Set("deltaX", 0);
          params.Set("deltaY", *delta);
        } else {
          params.Set("type", "mousePressed");
          params.Set("button", "left");
          params.Set("buttons", 1);
          params.Set("clickCount", 1);
        }
      }
      if (!space->Attach(contents)) {
        Reject(std::move(reply), 409, "target_busy");
        return;
      }
      if (*action == "type") {
        space->Send("Input.insertText", std::move(params));
      } else {
        space->Send("Input.dispatchMouseEvent", params.Clone());
        if (*action == "click") {
          params.Set("type", "mouseReleased");
          params.Set("buttons", 0);
          space->Send("Input.dispatchMouseEvent", std::move(params));
        }
      }
    } else {
      Reject(std::move(reply), 400, "unsupported_action");
      return;
    }
    result.Set("dispatched", true);
    Respond(std::move(reply), 200, std::move(result));
  }
  std::vector<std::unique_ptr<TaskSpace>> spaces_;
  base::WeakPtr<BrowserWindowInterface> browser_;
  base::CallbackListSubscription closed_;
  AgenticSpaceUpdate controls_;
  int visible_space_ = 0;
  bool reconciling_ = false;
  bool reconcile_pending_ = false;
  base::FilePath discovery_;
  scoped_refptr<base::SequencedTaskRunner> files_;
  int port_ = 0;
  base::Thread io_{"AgenticPoCIO"};
  base::SequenceBound<LocalServer> server_;
  base::RepeatingTimer remote_timer_;
  base::WeakPtrFactory<PocParts> weak_{this};
};
}  // namespace

std::unique_ptr<ChromeBrowserMainExtraParts> CreateAgenticPocParts() {
  return std::make_unique<PocParts>();
}
