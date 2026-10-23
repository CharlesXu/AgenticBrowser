#ifndef CHROME_BROWSER_AGENTIC_MODEL_HANDLER_H_
#define CHROME_BROWSER_AGENTIC_MODEL_HANDLER_H_
#include <memory>
namespace content { class WebUIMessageHandler; }
std::unique_ptr<content::WebUIMessageHandler> CreateAgenticModelHandler();
#endif
