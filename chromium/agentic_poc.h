#ifndef CHROME_BROWSER_AGENTIC_POC_H_
#define CHROME_BROWSER_AGENTIC_POC_H_

#include <memory>
#include <string>
#include "base/functional/callback.h"
#include "base/values.h"
namespace content { class WebContents; }
base::DictValue AgenticModelSpaces(content::WebContents* settings);
void AgenticModelSpaceRequest(content::WebContents* settings, const std::string& space, base::DictValue request, base::OnceCallback<void(int, std::string)> reply);
void AgenticCancelModelControl(content::WebContents* settings, const std::string& space, const std::string& lease);

#include "chrome/browser/chrome_browser_main_extra_parts.h"

// Space controls are part of every normal Agentic Browser window.
std::unique_ptr<ChromeBrowserMainExtraParts> CreateAgenticPocParts();

#endif
