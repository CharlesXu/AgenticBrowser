// Agentic Browser: private model settings and a scoped, user-started task bridge.
#include "chrome/browser/agentic_model_handler.h"
#include <algorithm>
#include <map>
#include <vector>
#include "chrome/browser/agentic_poc.h"
#include "chrome/browser/agentic_strings.h"
#include "base/base64.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/string_util.h"
#include "base/strings/escape.h"
#include "base/strings/utf_string_conversions.h"
#include "base/uuid.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/profiles/profile.h"
#include "components/os_crypt/async/browser/os_crypt_async.h"
#include "components/os_crypt/async/common/encryptor.h"
#include "components/prefs/pref_service.h"
#include "components/prefs/scoped_user_pref_update.h"
#include "content/public/browser/storage_partition.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_message_handler.h"
#include "net/base/load_flags.h"
#include "net/http/http_status_code.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "net/http/http_response_headers.h"
#include "url/origin.h"

namespace {
constexpr char kPref[] = "agentic.model_providers";
std::string Str(const base::DictValue& d, std::string_view key) {
  const auto* v=d.FindString(key); return v?*v:"";
}
bool TestResponse(const std::string& protocol, const base::DictValue& result) {
  if (protocol=="typesafe") {const auto* probe=result.FindDictByDottedPath("answers.probe");return probe&&Str(*probe,"choice")=="OK";}
  if (protocol=="openai") {
    const auto* a=result.FindList("choices");
    return a&&!a->empty()&&a->front().is_dict()&&a->front().GetDict().FindStringByDottedPath("message.content")&&!a->front().GetDict().FindStringByDottedPath("message.content")->empty();
  }
  const base::ListValue* parts=nullptr;
  if (protocol=="anthropic") parts=result.FindList("content");
  if (protocol=="gemini") {
    const auto* candidates=result.FindList("candidates");
    if (candidates&&!candidates->empty()&&candidates->front().is_dict()) parts=candidates->front().GetDict().FindListByDottedPath("content.parts");
  }
  if (protocol=="responses") {
    if (const auto* output=result.FindList("output")) for (const auto& item:*output) {
      if (!item.is_dict()) continue;
      if (const auto* content=item.GetDict().FindList("content")) for (const auto& part:*content)
        if (part.is_dict()&&Str(part.GetDict(),"type")=="output_text"&&!Str(part.GetDict(),"text").empty()) return true;
    }
  }
  if (parts) for (const auto& part:*parts) if (part.is_dict()&&!Str(part.GetDict(),"text").empty()) return true;
  return false;
}
class ModelHandler : public content::WebUIMessageHandler {
 public:
  ~ModelHandler() override { Stop(); }
  void RegisterMessages() override {
    web_ui()->RegisterMessageCallback("agenticModels",base::BindRepeating(&ModelHandler::Handle,base::Unretained(this)));
  }
  void OnJavascriptDisallowed() override { Stop(); loaders_.clear(); weak_.InvalidateWeakPtrs(); }
 private:
  PrefService* prefs() { return Profile::FromWebUI(web_ui())->GetPrefs(); }
  void Reply(base::Value id, base::DictValue value) { if(IsJavascriptAllowed()) ResolveJavascriptCallback(id,value); }
  void Error(base::Value id, const std::string& code) { if(IsJavascriptAllowed()) RejectJavascriptCallback(id,base::Value(code)); }
  void Stop() {
    if (web_ui()&&!space_.empty()) AgenticCancelModelControl(web_ui()->GetWebContents(),space_,Str(control_,"lease"));
    space_.clear();control_.clear();
  }
  base::DictValue Public(const base::DictValue& config) {
    auto value=config.Clone(); value.Set("hasKey",!Str(value,"encryptedKey").empty());value.Remove("encryptedKey");return value;
  }
  void Handle(const base::ListValue& args) {
    if(args.size()!=2||!args[0].is_string()||!args[1].is_dict()) return;
    AllowJavascript();auto id=args[0].Clone();const auto& data=args[1].GetDict();const auto op=Str(data,"op");
    if(op=="list") {
      base::DictValue result,labels;base::ListValue configs;
      for(const auto entry:prefs()->GetDict(kPref)) if(entry.second.is_dict()) configs.Append(Public(entry.second.GetDict()));
      for(const char* name:{"title","add","provider","custom","name","url","key","key_saved","protocol","model","fetch","test","remove","empty","testing","listed","verified","untested","hint","task","goal","space","decision","text_model","start","stop","resume","paused","done","blocked","running","refresh","task_hint","unavailable","failed","saved","steps","stopped"})
        labels.Set(name,base::UTF16ToUTF8(AgenticText(std::string("models_")+name)));
      result.Set("configs",std::move(configs));result.Set("labels",std::move(labels));Reply(std::move(id),std::move(result));return;
    }
    if(op=="spaces") {Reply(std::move(id),AgenticModelSpaces(web_ui()->GetWebContents()));return;}
    if(op=="stop") {Stop();Reply(std::move(id),base::DictValue().Set("stopped",true));return;}
    if(op=="space") {
      const auto* request=data.FindDict("request");if(!request){Error(std::move(id),"invalid_request");return;}
      const auto action=Str(*request,"action"),wanted=Str(data,"space");
      if(action=="claim") {if(!space_.empty()){Error(std::move(id),"already_running");return;} space_=wanted;}
      if(space_.empty()||space_!=wanted){Error(std::move(id),"space_not_authorized");return;}
      auto command=request->Clone();for(const char* field:{"lease","generation","tab"}) if(const auto* value=control_.Find(field)) command.Set(field,value->Clone());
      // Never accepts raw protocol commands or a main-space target from this UI.
      if(!std::ranges::contains(std::vector<std::string>{"claim","observe","resume","snapshot","xiangqiSnapshot","screenshot","click","clickRef","fillRef","scroll","handOff"},action)){Error(std::move(id),"action_not_allowed");return;}
      AgenticModelSpaceRequest(web_ui()->GetWebContents(),space_,std::move(command),base::BindOnce(&ModelHandler::SpaceReply,weak_.GetWeakPtr(),std::move(id),action));return;
    }
    if(op=="remove") {ScopedDictPrefUpdate update(prefs(),kPref);update->Remove(Str(data,"id"));Reply(std::move(id),base::DictValue());return;}
    if(op=="save"||op=="request") {
      g_browser_process->os_crypt_async()->GetInstance(base::BindOnce(&ModelHandler::WithCrypto,weak_.GetWeakPtr(),std::move(id),data.Clone()));return;
    }
    Error(std::move(id),"unknown_operation");
  }
  void SpaceReply(base::Value id,std::string action,int status,std::string json) {
    auto value=base::JSONReader::ReadDict(json,base::JSON_PARSE_RFC);
    if(status!=200||!value){if(action=="claim")space_.clear();Error(std::move(id),value?Str(*value,"error"):"space_failed");return;}
    for(const char* key:{"lease","generation","tab"}) if(const auto* v=value->Find(key)) control_.Set(key,v->Clone());
    value->Remove("lease"); Reply(std::move(id),std::move(*value));
  }
  void WithCrypto(base::Value callback,base::DictValue data,scoped_refptr<os_crypt_async::Encryptor> crypt) {
    if(!crypt||!crypt->IsEncryptionAvailable()){Error(std::move(callback),"key_store_unavailable");return;}
    auto id=Str(data,"id");const auto* old=prefs()->GetDict(kPref).FindDict(id);
    if(Str(data,"op")=="save") {
      const auto* value=data.FindDict("config");if(!value){Error(std::move(callback),"invalid_config");return;}
      if(id.empty())id=base::Uuid::GenerateRandomV4().AsLowercaseString();
      auto config=value->Clone();const GURL url(Str(config,"url"));const auto protocol=Str(config,"protocol");
      if(!url.is_valid()||!url.SchemeIsHTTPOrHTTPS()||url.has_username()||url.has_password()||url.has_query()||url.has_ref()||!url.path().ends_with('/')||Str(config,"name").empty()||Str(config,"name").size()>120||Str(config,"model").size()>256||!std::ranges::contains(std::vector<std::string>{"openai","responses","anthropic","gemini","typesafe"},protocol)) {Error(std::move(callback),"invalid_config");return;}
      const auto key=Str(data,"key");
      const bool identity_changed=old&&(Str(*old,"url")!=url.spec()||Str(*old,"protocol")!=protocol||Str(*old,"provider")!=Str(config,"provider"));
      std::string encrypted;
      if(!key.empty()) {
        if(key.size()>4096||key.find_first_of("\r\n")!=std::string::npos||!crypt->EncryptString(key,&encrypted)){Error(std::move(callback),"key_store_failed");return;}
        encrypted=base::Base64Encode(encrypted);
      } else if(old&&!identity_changed) encrypted=Str(*old,"encryptedKey");
      if(encrypted.empty()){Error(std::move(callback),"api_key_required");return;}
      base::DictValue saved;for(const char* field:{"name","provider","protocol","model"}) saved.Set(field,Str(config,field));
      if(const auto* models=config.FindList("models")) {
        if(models->size()>10000||std::ranges::any_of(*models,[](const base::Value& item){return !item.is_string()||item.GetString().empty()||item.GetString().size()>256;})){Error(std::move(callback),"invalid_model_list");return;}
        saved.Set("models",models->Clone());
      }
      saved.Set("custom",config.FindBool("custom").value_or(false));saved.Set("url",url.spec());saved.Set("id",id);saved.Set("encryptedKey",encrypted);
      saved.Set("revision",base::Uuid::GenerateRandomV4().AsLowercaseString());saved.Set("verified",false);
      {ScopedDictPrefUpdate update(prefs(),kPref);update->Set(id,saved.Clone());}
      prefs()->CommitPendingWrite();Reply(std::move(callback),Public(saved));return;
    }
    if(!old||Str(data,"revision")!=Str(*old,"revision")){Error(std::move(callback),"config_changed");return;}
    const std::string revision=Str(*old,"revision"),protocol=Str(*old,"protocol"),path=Str(data,"path");
    const GURL base(Str(*old,"url")),url=base.Resolve(path);
    const bool get=path=="models"||path.starts_with("models?");
    const bool allowed=get||(protocol=="openai"&&path=="chat/completions")||(protocol=="responses"&&path=="responses")||(protocol=="anthropic"&&path=="messages")||(protocol=="typesafe"&&path=="systemone")||(protocol=="gemini"&&path.starts_with("models/")&&path.ends_with(":generateContent"));
    if(!allowed||url::Origin::Create(url)!=url::Origin::Create(base)||!url.path().starts_with(base.path())){Error(std::move(callback),"invalid_endpoint");return;}
    std::string encrypted,key;if(!base::Base64Decode(Str(*old,"encryptedKey"),&encrypted)||!crypt->DecryptString(encrypted,&key)){Error(std::move(callback),"key_store_failed");return;}
    auto request=std::make_unique<network::ResourceRequest>();request->url=url;request->method=get?"GET":"POST";request->credentials_mode=network::mojom::CredentialsMode::kOmit;request->load_flags=net::LOAD_DISABLE_CACHE;
    if(protocol=="anthropic") {request->headers.SetHeader("x-api-key",key);request->headers.SetHeader("anthropic-version","2023-06-01");}
    else if(protocol=="gemini") request->headers.SetHeader("x-goog-api-key",key);
    else request->headers.SetHeader("Authorization","Bearer "+key);
    if(protocol=="typesafe") {
      const auto* body=data.FindDict("body");
      if(body&&body->FindDict("assets"))request->headers.SetHeader("TypeSafe-Danger-Zone-Images","true");
    }
    auto loader=network::SimpleURLLoader::Create(std::move(request),net::DefineNetworkTrafficAnnotation("agentic_model_request",R"(
      semantics {sender: "Agentic Browser model settings" description: "User-selected model provider, connection test or explicitly started browser task." trigger: "User supplies API credentials or starts a task." data: "Provider API key; test text or the selected task page and goal." destination: OTHER destination_other: "User-selected model API endpoint"}
      policy {cookies_allowed: NO setting: "No requests until a provider is configured by the user." policy_exception_justification: "User configured PoC model feature."})"));
    if(!get){const auto* body=data.FindDict("body");if(!body||(protocol=="gemini"?path!="models/"+base::EscapeAllExceptUnreserved(Str(*old,"model"))+":generateContent":Str(*body,"model")!=Str(*old,"model"))){Error(std::move(callback),"model_changed");return;}const auto json=base::WriteJson(*body);if(!json||json->size()>1024*1024){Error(std::move(callback),"request_too_large");return;}loader->AttachStringForUpload(*json,"application/json");}
    const bool test=data.FindBool("test").value_or(false)&&!get;
    if(test){ScopedDictPrefUpdate update(prefs(),kPref);update->FindDict(id)->Set("verified",false);}
    const int job=++sequence_;auto* raw=loader.get();loaders_[job]=std::move(loader);
    raw->SetTimeoutDuration(base::Seconds(30));raw->SetAllowHttpErrorResults(true);
    raw->SetOnRedirectCallback(base::BindRepeating(&ModelHandler::Redirect,weak_.GetWeakPtr(),job,callback.GetString()));
    raw->DownloadToString(Profile::FromWebUI(web_ui())->GetDefaultStoragePartition()->GetURLLoaderFactoryForBrowserProcess().get(),base::BindOnce(&ModelHandler::NetworkReply,weak_.GetWeakPtr(),job,std::move(callback),id,revision,protocol,test),4*1024*1024);
  }
  void Redirect(int job,std::string callback,const GURL&,const net::RedirectInfo&,const network::mojom::URLResponseHead&,std::vector<std::string>*) {
    loaders_.erase(job);Error(base::Value(callback),"redirect_not_allowed");
  }
  void NetworkReply(int job,base::Value callback,std::string id,std::string revision,std::string protocol,bool test,std::optional<std::string> body) {
    auto node=loaders_.extract(job);if(node.empty())return;auto& loader=node.mapped();
    const int status=loader->ResponseInfo()&&loader->ResponseInfo()->headers?loader->ResponseInfo()->headers->response_code():0;
    const auto* config=prefs()->GetDict(kPref).FindDict(id);
    if(!config||Str(*config,"revision")!=revision){Error(std::move(callback),"config_changed");return;}
    if(status<200||status>=300||!body){ScopedDictPrefUpdate update(prefs(),kPref);update->FindDict(id)->Set("verified",false);Error(std::move(callback),status?"HTTP "+std::to_string(status):"network_error");return;}
    auto value=base::JSONReader::ReadDict(*body,base::JSON_PARSE_RFC);
    if(!value){Error(std::move(callback),"invalid_model_response");return;}
    if(test) {
      // Missing answers are not a successful TypeSafe probe.
      if((protocol=="typesafe"&&!value->FindDictByDottedPath("answers.probe"))||!TestResponse(protocol,*value)){Error(std::move(callback),"invalid_model_response");return;}
      ScopedDictPrefUpdate update(prefs(),kPref);auto* stored=update->FindDict(id);stored->Set("verified",true);stored->Set("testedAt",base::Time::Now().InMillisecondsFSinceUnixEpoch());
    }
    Reply(std::move(callback),std::move(*value));
  }
  std::string space_;
  base::DictValue control_;
  int sequence_=0;
  std::map<int,std::unique_ptr<network::SimpleURLLoader>> loaders_;
  base::WeakPtrFactory<ModelHandler> weak_{this};
};
}
std::unique_ptr<content::WebUIMessageHandler> CreateAgenticModelHandler(){return std::make_unique<ModelHandler>();}
