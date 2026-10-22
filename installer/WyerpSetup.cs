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
 static readonly string Version="0.1.0-preview";
 Label details,status;
 Button install,open;
 ProgressBar progress;
 string root,data;
 bool busy=false;
 [STAThread] static void Main(string[] args){
   if(args.Length==1 && args[0]=="--verify-payload"){
      Console.WriteLine(VerifyEmbedded());return;
   }
   Application.EnableVisualStyles();
   Application.SetCompatibleTextRenderingDefault(false);
   Application.Run(new WyerpSetup());
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
 }
 void Clicked(object sender,EventArgs e){
   if(busy)return;
   if(Directory.Exists(data) || (Directory.Exists(root) && Directory.GetFileSystemEntries(root).Length>0)){
     MessageBox.Show(this,"检测到安装目录或用户数据已经存在，为了保护现有数据库和密钥，不允许再次执行首次安装。请使用已经安装的管理器。","保护现有数据",MessageBoxButtons.OK,MessageBoxIcon.Warning);return;
   }
   busy=true;install.Enabled=false;progress.Style=ProgressBarStyle.Marquee;status.Text="正在释放组件并初始化独立数据库...";
   Task.Run(()=>{
     try{
       VerifyEmbedded();
       if(Directory.Exists(data))throw new Exception("新安装前出现数据目录，已停止");
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
       string init=Path.Combine(root,"installer","Initialize.ps1");
       if(!File.Exists(init))throw new Exception("缺少数据库初始化脚本");
       var psi=new ProcessStartInfo("powershell.exe") {UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};
       psi.Arguments="-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \""+init+"\" -InstallRoot \""+root+"\" -DataRoot \""+data+"\"";
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
       MakeShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory),"网研 ERP.lnk"));
       MakeShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms),"网研 ERP.lnk"));
       BeginInvoke((Action)(()=>{progress.Style=ProgressBarStyle.Continuous;progress.Value=100;status.Text="安装完成。请用管理器启动ERP，并查看安全保存的admin密码。";open.Enabled=true;}));
     }catch(Exception ex){
       BeginInvoke((Action)(()=>{status.Text="安装没有完成。已保留现有文件，不会自动清除用户数据。";MessageBox.Show(this,ex.Message,"安装失败",MessageBoxButtons.OK,MessageBoxIcon.Error);}));
     }finally{BeginInvoke((Action)(()=>{busy=false;install.Enabled=true;progress.Style=ProgressBarStyle.Continuous;}));}
   });
 }
 void MakeShortcut(string path){
   Type t=Type.GetTypeFromProgID("WScript.Shell");
   if(t==null)throw new Exception("此Windows系统没有创建快捷方式的组件");
   object shell=Activator.CreateInstance(t);
   object link=t.InvokeMember("CreateShortcut",System.Reflection.BindingFlags.InvokeMethod,null,shell,new object[]{path});
   var linkType=link.GetType();
   linkType.InvokeMember("TargetPath",System.Reflection.BindingFlags.SetProperty,null,link,new object[]{Path.Combine(root,"WyerpERP-Manager.exe")});
   linkType.InvokeMember("WorkingDirectory",System.Reflection.BindingFlags.SetProperty,null,link,new object[]{root});
   linkType.InvokeMember("Save",System.Reflection.BindingFlags.InvokeMethod,null,link,new object[]{});
 }
}