#ifndef CHROME_BROWSER_AGENTIC_SPACE_CONTROLS_H_
#define CHROME_BROWSER_AGENTIC_SPACE_CONTROLS_H_

#include <array>
#include <string>
#include <vector>

#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"

class BrowserWindowInterface;
namespace content {
class WebContents;
}

enum class AgenticSpaceOwner { kAvailable, kHuman, kAgent, kAwaitingResume, kRemote };

// Native UI data only. Main Space is never exposed through the Agent API.
struct AgenticSpacePresentation {
  int id = 0;
  int number = 0;
  std::u16string name;
  std::u16string status;
  AgenticSpaceOwner owner = AgenticSpaceOwner::kAvailable;
  int viewers = 0;
  std::vector<std::u16string> tabs;
  int selected_tab = 0;
  base::WeakPtr<content::WebContents> contents;
  bool can_return = false;
  bool can_close = false;
};

enum class AgenticSpaceCommand { kSelect, kTake, kReturn, kCreate, kClose };
using AgenticSpaceAction = base::RepeatingCallback<void(AgenticSpaceCommand, int)>;
using AgenticSpaceUpdate = base::RepeatingCallback<void(
    int, const std::vector<AgenticSpacePresentation>&)>;

AgenticSpaceUpdate AddAgenticSpaceControls(BrowserWindowInterface* browser,
                                          AgenticSpaceAction action);

#endif  // CHROME_BROWSER_AGENTIC_SPACE_CONTROLS_H_
