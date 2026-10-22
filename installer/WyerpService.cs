using System;
using System.IO;
using System.Diagnostics;
using System.ServiceProcess;
using System.Threading;
class WyerpERPService : ServiceBase {
 string root,data,instance;
 Process child;
 Thread monitor;
 volatile bool stopping;
 public WyerpERPService(string r,string d,string n) {root=r;data=d;instance=n;ServiceName=n;CanStop=true;CanShutdown=true;AutoLog=true;}
 static string Arg(string[] args,string key){
  for(int i=0;i<args.Length-1;i++)if(args[i]==key)return args[i+1];
  return null;
 }
 static void Main(string[] args){
  string root=Arg(args,"--install-root"), data=Arg(args,"--data-root"), service=Arg(args,"--service-name");
  if(String.IsNullOrEmpty(root)||String.IsNullOrEmpty(data)||String.IsNullOrEmpty(service)){Environment.ExitCode=2;return;}
  ServiceBase.Run(new WyerpERPService(Path.GetFullPath(root),Path.GetFullPath(data),service));
 }
 void Log(string message){
  try{File.AppendAllText(Path.Combine(data,"logs","service-lifecycle.log"),DateTime.UtcNow.ToString("o")+" "+message+Environment.NewLine);}catch{}
 }
 readonly object outputLogLock=new object();
 void AppendAppLog(string line){
  try{lock(outputLogLock){File.AppendAllText(Path.Combine(data,"logs","erp-service.log"),line+Environment.NewLine);}}catch{}
 }
 protected override void OnStart(string[] args){
  if(!File.Exists(Path.Combine(root,"installer","Run-Server.ps1"))||!File.Exists(Path.Combine(data,"install-settings.json")))throw new InvalidOperationException("ERP安装配置缺失");
  stopping=false;
  monitor=new Thread(RunLoop){IsBackground=true,Name="WyerpERPNodeMonitor"};
  monitor.Start();
 }
 void RunLoop(){
  int failures=0;
  while(!stopping){
   try{
    string node=Path.Combine(root,"runtime","node","node.exe");
    string config=Path.Combine(data,"secrets","wyerp.env");
    string supervisor=Path.Combine(root,"erp","auth","runtime-supervisor.js");
    string singleServer=Path.Combine(root,"erp","server.js");
    var start=new ProcessStartInfo(node){
     Arguments="--env-file-if-exists=\""+config+"\" \""+supervisor+"\" \""+singleServer+"\"",
     UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,WorkingDirectory=Path.Combine(root,"erp")
    };
    start.EnvironmentVariables["WYERP_LOCAL_DATA_ROOT"]=data;
    start.EnvironmentVariables["ERP_CREDENTIALS_KEY_FILE"]=Path.Combine(data,"secrets","credentials.key");
    start.EnvironmentVariables["ERP_CSRF_SECRET_FILE"]=Path.Combine(data,"secrets","csrf.key");
    start.EnvironmentVariables["ERP_PRIVATE_OBJECT_KEY_FILE"]=Path.Combine(data,"secrets","private-object.key");
    start.EnvironmentVariables["ERP_RUNTIME_STATE_FILE"]=Path.Combine(data,"run","runtime-supervisor.json");
    start.EnvironmentVariables["ERP_PRIVATE_OBJECT_DIR"]=Path.Combine(data,"private-objects");
    start.EnvironmentVariables["ERP_LOGISTICS_TARIFF_DIR"]=Path.Combine(data,"logistics");
    start.EnvironmentVariables["ERP_BACKUP_DIR"]=Path.Combine(data,"backups");
    start.EnvironmentVariables["ERP_CLUSTER_ENABLED"]="0";
    start.EnvironmentVariables["ERP_NODE_ROLE"]="all";
    start.EnvironmentVariables["WYERP_STANDALONE_MODE"]="1";
    start.EnvironmentVariables["ERP_HOST"]="127.0.0.1";
    Process current=Process.Start(start);
    if(current==null)throw new Exception("ERP process failed to start");
    current.OutputDataReceived+=(s,e)=>{if(e.Data!=null)AppendAppLog(e.Data);};
    current.ErrorDataReceived+=(s,e)=>{if(e.Data!=null)AppendAppLog("ERROR "+e.Data);};
    current.BeginOutputReadLine();current.BeginErrorReadLine();
    child=current;
    Log("launched ERP runtime pid="+current.Id);
    current.WaitForExit();
    int code=current.ExitCode;
    if(!stopping)Log("ERP runtime exited unexpectedly code="+code);
    current.Dispose();
    if(Object.ReferenceEquals(child,current))child=null;
   }catch(Exception ex){Log("run-loop error="+ex.GetType().Name);}
   if(stopping)break;
   failures++;
   int pause=failures>5?12000:2500;
   for(int i=0;i<pause/250 && !stopping;i++)Thread.Sleep(250);
  }
 }
 protected override void OnStop(){StopOwnedChild();}
 protected override void OnShutdown(){StopOwnedChild();base.OnShutdown();}
 void StopOwnedChild(){
  stopping=true;
  Process p=child;
  if(p!=null){
   try{
    if(!p.HasExited){
      using(var killer=Process.Start(new ProcessStartInfo("taskkill.exe"){
        Arguments="/PID "+p.Id+" /T /F",CreateNoWindow=true,UseShellExecute=false
      })){killer.WaitForExit(15000);}
      p.WaitForExit(3000);
    }
   }catch(Exception ex){Log("shutdown process="+ex.GetType().Name);}
  }
  try{if(monitor!=null)monitor.Join(4000);}catch{}
  Log("ERP runtime service stopped");
 }
}