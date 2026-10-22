#ifndef CHROME_BROWSER_AGENTIC_POC_H_
#define CHROME_BROWSER_AGENTIC_POC_H_

#include <memory>

#include "chrome/browser/chrome_browser_main_extra_parts.h"

// Enabled only by --agentic-poc; ordinary Chromium startup is unchanged.
std::unique_ptr<ChromeBrowserMainExtraParts> CreateAgenticPocParts();

#endif
