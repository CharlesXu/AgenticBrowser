#ifndef CHROME_BROWSER_AGENTIC_POC_H_
#define CHROME_BROWSER_AGENTIC_POC_H_

#include <memory>

#include "chrome/browser/chrome_browser_main_extra_parts.h"

// Space controls are part of every normal Agentic Browser window.
std::unique_ptr<ChromeBrowserMainExtraParts> CreateAgenticPocParts();

#endif
