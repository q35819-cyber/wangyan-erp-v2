using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Threading;
using System.Windows.Forms;
using System.ComponentModel;
using System.Text;
using System.Text.RegularExpressions;
class WyerpManager : Form {
 static Mutex single;
 static bool qaUiManager=false;
 Label headline, status;
 Button start, restart, stop, open, plugin, password;

 string root, data;
 bool busy=false;
 [STAThread] static int Main(string[] args) {
   qaUiManager=args.Length==1 && args[0]=="--qa-ui-manager";
   bool created=false;
   single=new Mutex(true, qaUiManager?"Local\\WyerpCommunityManagerQA20261022":"Local\\WyerpCommunityManager",out created);
   if(!created) {
     // A second click must not open a stale/offline browser URL.
     // Ask the same instance-specific readiness gate to start the service first.
     try{
       string installedRoot=AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
       string privateData=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"WyerpERP-Community");
       if(qaUiManager)privateData=@"D:\WyerpIsolatedDeployQA-20261022\gui-installer-qa10-20261023\data";
       string control=Path.Combine(installedRoot,"installer","Control.ps1");
       if(File.Exists(control)&&File.Exists(Path.Combine(privateData,"install-settings.json"))){
         var startInfo=new ProcessStartInfo("powershell.exe"){
           Arguments="-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \""+control+"\" -Action Open -InstallRoot \""+installedRoot+"\" -DataRoot \""+privateData+"\"",
           UseShellExecute=false,CreateNoWindow=true
         };
         using(var existing=Process.Start(startInfo)){if(existing!=null)existing.WaitForExit(90000);}
       }
     }catch(Exception err){MessageBox.Show("无法启动单机服务："+err.Message,"网研ERP");}
     return 0;
   }
   try {
     Application.EnableVisualStyles();
     Application.SetCompatibleTextRenderingDefault(false);
     Application.Run(new WyerpManager());
     return 0;
   } finally { single.ReleaseMutex();single.Dispose(); }
 }
 WyerpManager() {
   root=AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
   data=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"WyerpERP-Community");
   if(qaUiManager){
     string b=@"D:\WyerpIsolatedDeployQA-20261022\gui-installer-qa10-20261023";
     if(!root.Equals(Path.Combine(b,"program"),StringComparison.OrdinalIgnoreCase))throw new Exception("QA UI manager must run from verified isolated instance");
     data=Path.Combine(b,"data");
   }
   Text="网研 ERP · 单机管理器";
   Size=new Size(525,395); MinimumSize=new Size(525,395); MaximumSize=new Size(525,395);
   StartPosition=FormStartPosition.CenterScreen;
   BackColor=Color.FromArgb(245,247,251);
   Font=new Font("Microsoft YaHei UI",9);
   headline=new Label {Text="网研 ERP",Font=new Font("Microsoft YaHei UI",18,FontStyle.Bold),Bounds=new Rectangle(28,22,460,44)};
   Controls.Add(headline);
   status=new Label{Text="正在读取本机状态…",Bounds=new Rectangle(30,75,460,50),ForeColor=Color.FromArgb(55,65,81),AutoSize=false};
   Controls.Add(status);
   start=MakeButton("启动 ERP",30,144,142,46,(s,e)=>RunAction("Start",false));
   restart=MakeButton("重启 ERP",190,144,142,46,(s,e)=>RunAction("Restart",false));
   stop=MakeButton("关闭后台服务",350,144,142,46,(s,e)=>RunAction("Stop",false));
   open=MakeButton("打开 ERP 网页",30,204,222,43,(s,e)=>RunAction("Open",false));
   plugin=MakeButton("安装浏览器插件",270,204,222,43,(s,e)=>RunAction("Plugin",false));
   password=MakeButton("查看初始管理员密码",30,264,462,43,(s,e)=>OpenPassword());
   var hint=new Label{Text="关闭这个窗口不会关闭ERP，后台会继续运行；仅“关闭后台服务”会停止。",Bounds=new Rectangle(30,324,465,27),ForeColor=Color.FromArgb(95,104,120)};
   Controls.Add(hint);
   Shown+=(s,e)=>{if(qaUiManager)RunAction("Status",true);else RunAction("Start",false);};
   FormClosing+=ClosingManager;
 }
 Button MakeButton(string label,int x,int y,int w,int h,EventHandler action) {
   var b=new Button {Text=label,Bounds=new Rectangle(x,y,w,h),FlatStyle=FlatStyle.System};
   b.Click+=action;Controls.Add(b);return b;
 }
 void Busy(bool value){
   busy=value;
   foreach(var b in new[]{start,restart,stop,open,plugin,password})b.Enabled=!value;
 }
 string GetUrl(){
   try{
     string f=Path.Combine(data,"install-settings.json");
     if(File.Exists(f)) {
       var match=Regex.Match(File.ReadAllText(f),"\"AppPort\"\\s*:\\s*(\\d+)");
       if(match.Success){int port=int.Parse(match.Groups[1].Value);if(port>=1024&&port<=65535)return "http://127.0.0.1:"+port;}
     }
   }catch{}
   return "http://127.0.0.1:8765";
 }
 void OpenPassword(){
   string f=Path.Combine(data,"secrets","initial-admin-password.txt");
   if(!File.Exists(f)) {MessageBox.Show(this,"初始管理员密码文件不存在。请检查是否已经安全保存或删除。","网研ERP");return;}
   Process.Start("notepad.exe","\""+f+"\"");
 }
 bool ConfirmStop(){
   if(qaUiManager)return true;
   return MessageBox.Show(this,"现在关闭ERP后台会中断正在进行的同步或保存操作。确定已经完成操作并退出吗？","确认停止",MessageBoxButtons.YesNo,MessageBoxIcon.Warning)==DialogResult.Yes;
 }
 void RunAction(string action,bool silent){
   if(busy)return;
   if((action=="Stop"||action=="Restart")&&!silent&&!ConfirmStop())return;
   Busy(true); status.Text="正在执行："+action+" …";
   Task.Run(()=>{
     string output="";
     try{
       string tool=Path.Combine(root,"installer","Control.ps1");
       if(!File.Exists(tool))throw new FileNotFoundException("管理程序文件缺失",tool);
       var p=new ProcessStartInfo("powershell.exe");
       p.Arguments="-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \""+tool+"\" -Action "+action+" -InstallRoot \""+root+"\" -DataRoot \""+data+"\"";
       p.UseShellExecute=false;
       p.CreateNoWindow=true;p.RedirectStandardOutput=true;p.RedirectStandardError=true;
        using(var process=Process.Start(p)) {
         if(process==null)throw new Exception("Windows后台进程未成功启动");
         var stdoutTask=process.StandardOutput.ReadToEndAsync();
         var stderrTask=process.StandardError.ReadToEndAsync();
         if(!process.WaitForExit(90000)){try{process.Kill();}catch{}throw new Exception("控制操作超过90秒");}
          Task.WaitAll(stdoutTask,stderrTask);
         output=stdoutTask.Result+Environment.NewLine+stderrTask.Result;
         if(process.ExitCode!=0)throw new Exception(output.Length>800?output.Substring(output.Length-800):output);
       }
       BeginInvoke((Action)(()=>{
         status.Text=action=="Status"?output.Trim():"已完成："+action+"    "+GetUrl();
         if(action=="Start"||action=="Open") {if(action=="Start") {try{Process.Start(new ProcessStartInfo(GetUrl()){UseShellExecute=true});}catch{}}}
       }));
     }catch(Exception ex){
       BeginInvoke((Action)(()=>{status.Text="操作未完成，请检查提示";if(!silent)MessageBox.Show(this,ex.Message,"网研ERP",MessageBoxButtons.OK,MessageBoxIcon.Error);}));
     }finally{BeginInvoke((Action)(()=>Busy(false)));}
   });
 }
 void ClosingManager(object sender,FormClosingEventArgs e){
   // Window lifetime and Windows service lifetime are independent.
   // Only the explicit "关闭后台服务" button is allowed to stop the backend.
   // Closing or crashing the manager must NEVER call Control.ps1 Stop.
 }
}
