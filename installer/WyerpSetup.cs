using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Drawing;
using System.Diagnostics;
using System.Threading.Tasks;
using System.Text;
using System.Windows.Forms;
using System.Collections.Generic;
using System.Runtime.InteropServices;
class WyerpSetup : Form {
 static readonly string Version="0.1.0-preview18";
 static bool qaGuiInstall=false;
 static int qaGuiExitCode=3;
 static readonly string qaBase=@"D:\WyerpIsolatedDeployQA-20261022\gui-installer-qa10-20261023";
 Label details,status;
 Button install,open;
 ProgressBar progress;
 string root,data;
 bool busy=false;
 [STAThread] static void Main(string[] args){
   if(args.Length==1 && args[0]=="--verify-payload"){
      Console.WriteLine(VerifyEmbedded());return;
   }
   qaGuiInstall=args.Length==1 && args[0]=="--qa-ui-install";
    Application.EnableVisualStyles();
   Application.SetCompatibleTextRenderingDefault(false);
   Application.Run(new WyerpSetup());
    if(qaGuiInstall)Environment.ExitCode=qaGuiExitCode;
 }
 static string VerifyEmbedded(){
   using(var raw=Assembly.GetExecutingAssembly().GetManifestResourceStream("WyerpPayload.zip")){
     if(raw==null)throw new Exception("EXE里没有安装资源");
     using(var zip=new ZipArchive(raw,ZipArchiveMode.Read)){
       bool node=false,pg=false,src=false,manager=false;
       foreach(var e in zip.Entries){
         if(e.FullName=="runtime/node/node.exe")node=true;
         if(e.FullName=="runtime/postgresql/bin/initdb.exe")pg=true;
         if(e.FullName=="erp/server.js")src=true;
         if(e.FullName=="WyerpERP-Manager.exe")manager=true;
       }
       if(!node||!pg||!src||!manager)throw new Exception("安装包不完整");
       return "PASS payload ZIP and embedded Node, PostgreSQL, ERP and manager; files="+zip.Entries.Count;
     }
   }
 }
 WyerpSetup() {
   root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"WyerpERP Community");
   data=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"WyerpERP-Community");
   if(qaGuiInstall){root=Path.Combine(qaBase,"program");data=Path.Combine(qaBase,"data");}
   Text="网研ERP · Windows单机安装程序";
   Size=new Size(595,340);MaximumSize=new Size(595,340);MinimumSize=new Size(595,340);StartPosition=FormStartPosition.CenterScreen;
   Font=new Font("Microsoft YaHei UI",9);
   Controls.Add(new Label{Text="网研 ERP  单机社区版",Font=new Font("Microsoft YaHei UI",16,FontStyle.Bold),Bounds=new Rectangle(25,20,530,41)});
   details=new Label{Text="自动安装 ERP、Node.js 与独立 PostgreSQL。\r\n安装目录："+root+"\r\n私有数据："+data+"\r\n只监听本机，升级和卸载默认保留数据。",Bounds=new Rectangle(25,72,540,92)};
   Controls.Add(details);
   progress=new ProgressBar{Bounds=new Rectangle(25,170,540,18),Style=ProgressBarStyle.Continuous};
   Controls.Add(progress);
   install=new Button{Text="开始安装",Bounds=new Rectangle(25,205,220,43)};
   Controls.Add(install);install.Click+=Clicked;
   open=new Button{Text="打开网研ERP管理器",Bounds=new Rectangle(269,205,296,43),Enabled=false};
   Controls.Add(open);open.Click+=(s,e)=>{Process.Start(Path.Combine(root,"WyerpERP-Manager.exe"));};
   status=new Label{Text="单击「开始安装」，无需填写端口、数据库或管理员密码。",Bounds=new Rectangle(25,264,540,40),AutoSize=false};
   Controls.Add(status);
   if(qaGuiInstall){Shown+=(s,e)=>BeginInvoke((Action)(()=>install.PerformClick()));}
 }
 void Clicked(object sender,EventArgs e){
   if(busy)return;
   bool restoring=Directory.Exists(data);
   bool programExists=Directory.Exists(root) && Directory.GetFileSystemEntries(root).Length>0;
   if(programExists || (restoring && !File.Exists(Path.Combine(data,"install-settings.json")))) {
     if(qaGuiInstall){FinishQA(false,"existing-install");return;}
     MessageBox.Show(this,"现有程序尚未卸载，或用户数据目录没有有效安装记录。拒绝覆盖。","保护现有数据",MessageBoxButtons.OK,MessageBoxIcon.Warning);
     return;
   }
   if(restoring && !qaGuiInstall && MessageBox.Show(this,"找到已保留的数据库和原设置。确定恢复原安装，不重置账号和数据吗？","安全恢复原安装",MessageBoxButtons.YesNo,MessageBoxIcon.Question)!=DialogResult.Yes)return;
   busy=true;install.Enabled=false;progress.Style=ProgressBarStyle.Marquee;
   status.Text=restoring?"正在恢复现有数据库与程序...":"正在安装新的独立ERP数据库...";
   Task.Run(()=>{
     try{
       VerifyEmbedded();
       if(Directory.Exists(data) && !restoring)throw new Exception("发现未经许可的数据目录，拒绝覆盖");
       Directory.CreateDirectory(root);
       using(var raw=Assembly.GetExecutingAssembly().GetManifestResourceStream("WyerpPayload.zip")){
        using(var zip=new ZipArchive(raw,ZipArchiveMode.Read)){
          string absroot=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar;
          foreach(var file in zip.Entries){
            string output=Path.GetFullPath(Path.Combine(root,file.FullName.Replace('/',Path.DirectorySeparatorChar)));
            if(!output.StartsWith(absroot,StringComparison.OrdinalIgnoreCase))throw new Exception("安装资源非法路径");
            if(file.FullName.EndsWith("/")){Directory.CreateDirectory(output);continue;}
            Directory.CreateDirectory(Path.GetDirectoryName(output));
            using(var a=file.Open()){using(var b=new FileStream(output,FileMode.CreateNew,FileAccess.Write,FileShare.None)){a.CopyTo(b);}}
          }
        }
       }
       string init=Path.Combine(root,"installer",restoring?"Recover-Existing.ps1":"Initialize.ps1");
       if(!File.Exists(init))throw new Exception("缺少数据库初始化脚本");
       var psi=new ProcessStartInfo("powershell.exe") {UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};
       psi.Arguments="-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \""+init+"\" -InstallRoot \""+root+"\" -DataRoot \""+data+"\""+(!restoring && qaGuiInstall?" -ServiceName WyerpCommunityPGUIQA10 -AppPort 18780 -PgPort 55455":"");
       using(var ps=Process.Start(psi)){
         var readOut=ps.StandardOutput.ReadToEndAsync();
         var readErr=ps.StandardError.ReadToEndAsync();
         if(!ps.WaitForExit(240000)){try{ps.Kill();}catch{}throw new Exception("数据库初始化超时，已停止；保留目录供修复，禁止覆盖重试");}
         Task.WaitAll(readOut,readErr);
         if(ps.ExitCode!=0){
           string message=readErr.Result;
           if(message.Length>700)message=message.Substring(message.Length-700);
           throw new Exception("初始化失败，请保留目录并检查日志："+message);
         }
       }
       string packagedUninstall=Path.Combine(root,"WyerpERP-Uninstall.exe");
       if(!File.Exists(packagedUninstall))throw new Exception("安装包缺少安全卸载程序");
       string durableFolder=Path.Combine(data,"tools");
       Directory.CreateDirectory(durableFolder);
       string durableUninstall=Path.Combine(durableFolder,"WyerpERP-Uninstall.exe");
       File.Copy(packagedUninstall,durableUninstall,restoring);
       MakeShortcut(qaGuiInstall?Path.Combine(qaBase,"shortcuts","desktop","网研 ERP.lnk"):Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory),"网研 ERP.lnk"));
       MakeShortcut(qaGuiInstall?Path.Combine(qaBase,"shortcuts","startmenu","网研 ERP.lnk"):Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms),"网研 ERP.lnk"));
       MakeShortcut(qaGuiInstall?Path.Combine(qaBase,"shortcuts","startmenu","卸载网研 ERP.lnk"):Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms),"卸载网研 ERP.lnk"),durableUninstall);
       if(!qaGuiInstall){
         string regPath=@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\WyerpERP-Community";
         using(var key=Microsoft.Win32.Registry.LocalMachine.CreateSubKey(regPath)){
           if(key==null)throw new Exception("无法注册Windows程序卸载入口");
           key.SetValue("DisplayName","网研 ERP 社区单机版");
           key.SetValue("DisplayVersion","0.1.0-preview18");
           key.SetValue("Publisher","Wyerp Community");
           key.SetValue("InstallLocation",root);
           key.SetValue("UninstallString","\""+durableUninstall+"\"");
           key.SetValue("NoModify",1,Microsoft.Win32.RegistryValueKind.DWord);
           key.SetValue("NoRepair",1,Microsoft.Win32.RegistryValueKind.DWord);
         }
       }
       BeginInvoke((Action)(()=>{progress.Style=ProgressBarStyle.Continuous;progress.Value=100;status.Text="安装完成。请用管理器启动ERP，并查看安全保存的admin密码。";open.Enabled=true;if(qaGuiInstall)FinishQA(true,restoring?"restored":"installed");}));
     }catch(Exception ex){
       BeginInvoke((Action)(()=>{status.Text="安装没有完成。已保留现有文件，不会自动清除用户数据。";if(qaGuiInstall){FinishQA(false,ex.GetType().Name+":"+ex.Message);}else{MessageBox.Show(this,ex.Message,"安装失败",MessageBoxButtons.OK,MessageBoxIcon.Error);}}));
     }finally{BeginInvoke((Action)(()=>{busy=false;install.Enabled=true;progress.Style=ProgressBarStyle.Continuous;}));}
   });
 }
 void FinishQA(bool success,string reason){
   qaGuiExitCode=success?0:4;
   try {
     Directory.CreateDirectory(qaBase);
     File.WriteAllText(Path.Combine(qaBase,"qa-gui-result.txt"),(success?"PASS":"FAIL")+" "+reason);
   }catch{}
   Close();
 } void MakeShortcut(string path,string targetOverride=null){
   Directory.CreateDirectory(Path.GetDirectoryName(path));
   Type t=Type.GetTypeFromProgID("WScript.Shell");
   if(t==null)throw new Exception("此Windows系统没有创建快捷方式的组件");
   object shell=Activator.CreateInstance(t);
   object link=t.InvokeMember("CreateShortcut",System.Reflection.BindingFlags.InvokeMethod,null,shell,new object[]{path});
   var linkType=link.GetType();
   linkType.InvokeMember("TargetPath",System.Reflection.BindingFlags.SetProperty,null,link,new object[]{targetOverride??Path.Combine(root,"WyerpERP-Manager.exe")});
   linkType.InvokeMember("WorkingDirectory",System.Reflection.BindingFlags.SetProperty,null,link,new object[]{root});
   linkType.InvokeMember("Save",System.Reflection.BindingFlags.InvokeMethod,null,link,new object[]{});
 }
}