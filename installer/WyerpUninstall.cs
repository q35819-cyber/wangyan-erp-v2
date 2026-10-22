using System;
using System.IO;
using System.Drawing;
using System.Diagnostics;
using System.Windows.Forms;
using System.Collections.Generic;
using System.ServiceProcess;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using System.Threading.Tasks;
using System.Text;
using System.Text.RegularExpressions;
using System.Reflection;
class WyerpUninstall : Form {
 static bool qa=false;
 static int qaExit=3;
 static readonly string qaBase=@"D:\WyerpIsolatedDeployQA-20261022\gui-installer-qa12-20261023";
 string root,data;
 Button remove;
 Label label;
 bool busy=false;
 [STAThread]static void Main(string[] args) {
  qa=args.Length==1 && args[0]=="--qa-ui-uninstall";
  Application.EnableVisualStyles();
  Application.SetCompatibleTextRenderingDefault(false);
  Application.Run(new WyerpUninstall());
  if(qa)Environment.ExitCode=qaExit;
 }
 WyerpUninstall() {
   string ownFolder=AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
   data=Path.GetFullPath(Path.Combine(ownFolder,".."));
   if(qa){
     if(!ownFolder.Equals(Path.Combine(qaBase,"data","tools"),StringComparison.OrdinalIgnoreCase))throw new Exception("QA uninstaller not in data/tools");
     data=Path.Combine(qaBase,"data");
   }else{
     string expected=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"WyerpERP-Community");
     if(!Path.GetFullPath(data).Equals(Path.GetFullPath(expected),StringComparison.OrdinalIgnoreCase))throw new Exception("Uninstaller not in trusted data tools");
   }
   string config=Path.Combine(data,"install-settings.json");
   if(!File.Exists(config))throw new Exception("Missing install settings");
   root=Field(LoadSettings(config),"InstallRoot");
  Text="卸载网研 ERP（保留用户数据）";
  Size=new Size(490,267);MinimumSize=new Size(490,267);MaximumSize=new Size(490,267);
  Font=new Font("Microsoft YaHei UI",10);
  StartPosition=FormStartPosition.CenterScreen;
  Controls.Add(new Label{Text="卸载网研 ERP 程序",Font=new Font("Microsoft YaHei UI",16,FontStyle.Bold),Bounds=new Rectangle(24,19,440,42)});
  label=new Label{Text="将停止当前ERP和其专属数据库服务，移除程序与快捷方式。\r\n重要：数据库、API密钥及管理员资料会保留，可供重新安装恢复。",Bounds=new Rectangle(24,76,435,75)};
  Controls.Add(label);
  remove=new Button{Text="卸载程序（保留我的数据）",Bounds=new Rectangle(24,166,438,40)};
  remove.Click+=Clicked;Controls.Add(remove);
  if(qa)Shown+=(s,e)=>BeginInvoke((Action)(()=>remove.PerformClick()));
 }
 void RecordQa(bool pass,string reason) {
   qaExit=pass?0:4;
   try{
    Directory.CreateDirectory(qaBase);
    File.WriteAllText(Path.Combine(qaBase,"qa-uninstall-result.txt"),(pass?"PASS ":"FAIL ")+reason);
   }catch{}
   Close();
 }
 static Dictionary<string,object> LoadSettings(string file){
  return new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(file,Encoding.UTF8));
 }
 static string Field(Dictionary<string,object> settings,string name){
  if(!settings.ContainsKey(name))throw new Exception("安装配置缺少 "+name);
  return Convert.ToString(settings[name]);
 }
 string ValidateAndGetService(Dictionary<string,object> s,string field,string prefix){
  string name=Field(s,field);
  if(!Regex.IsMatch(name,"^"+prefix+"[A-Za-z0-9]*$"))throw new Exception("非法服务名称");
  return name;
 }
 static string RunSc(string verb,string name){
  var start=new ProcessStartInfo("sc.exe"){Arguments=verb+" "+name,UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};
  using(var p=Process.Start(start)){
   string stdout=p.StandardOutput.ReadToEnd();
   string stderr=p.StandardError.ReadToEnd();
   if(!p.WaitForExit(12000))throw new Exception("Windows服务管理命令超时");
   if(p.ExitCode!=0)throw new Exception("Windows服务操作失败: "+verb+" "+name+" "+stderr);
   return stdout;
  }
 }
  void StopDeleteService(string name) {
   bool found=false;
   foreach(var existing in ServiceController.GetServices()){
    if(String.Equals(existing.ServiceName,name,StringComparison.OrdinalIgnoreCase)){found=true;break;}
   }
   if(!found)return;
   string qc=RunSc("qc",name);
   if(qc.IndexOf(root,StringComparison.OrdinalIgnoreCase)<0)throw new Exception("Foreign Windows service path, refusing uninstall: "+name);
   using(var service=new ServiceController(name)){
     if(service.Status!=ServiceControllerStatus.Stopped){
       service.Stop();
       service.WaitForStatus(ServiceControllerStatus.Stopped,TimeSpan.FromSeconds(30));
     }
   }
   RunSc("delete",name);
  }
 void RemoveShortcutIfOwned(string name,string folder){
  string path=Path.Combine(folder,name);
  if(!File.Exists(path))return;
  Type shellType=Type.GetTypeFromProgID("WScript.Shell");
  if(shellType==null)return;
  object shell=Activator.CreateInstance(shellType);
  object lnk=shellType.InvokeMember("CreateShortcut",BindingFlags.InvokeMethod,null,shell,new object[]{path});
  object target=lnk.GetType().InvokeMember("TargetPath",BindingFlags.GetProperty,null,lnk,new object[]{});
  string destination=Convert.ToString(target);
  string expected=name.StartsWith("卸载")?Path.Combine(data,"tools","WyerpERP-Uninstall.exe"):Path.Combine(root,"WyerpERP-Manager.exe");
  if(String.Equals(Path.GetFullPath(destination),Path.GetFullPath(expected),StringComparison.OrdinalIgnoreCase))File.Delete(path);
 }
 void Clicked(object sender,EventArgs e) {
  if(busy)return;
  if(!qa && MessageBox.Show(this,"确定卸载程序并停止后台？数据库及个人配置将保留。","确认卸载",MessageBoxButtons.YesNo,MessageBoxIcon.Warning)!=DialogResult.Yes)return;
  busy=true;remove.Enabled=false;label.Text="正在检查本实例并停止专属服务...";
  Task.Run(()=>{
   try{
    string settingsFile=Path.Combine(data,"install-settings.json");
    if(!File.Exists(settingsFile))throw new Exception("找不到安装记录，拒绝卸载未知程序");
    var settings=LoadSettings(settingsFile);
    if(!Path.GetFullPath(Field(settings,"InstallRoot")).TrimEnd('\\').Equals(Path.GetFullPath(root).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))throw new Exception("安装目录与本机数据记录不一致");
    if(!qa){
      string expected=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"WyerpERP Community");
      if(!Path.GetFullPath(expected).Equals(Path.GetFullPath(root),StringComparison.OrdinalIgnoreCase))throw new Exception("不是受支持的默认安装目录，拒绝自动删除");
    }
    if(!File.Exists(Path.Combine(root,"erp","server.js"))||!File.Exists(Path.Combine(root,"WyerpERP-Service.exe")))throw new Exception("未验证的程序目录");
    string erp=ValidateAndGetService(settings,"AppServiceName","WyerpCommunityERP");
    string pg=ValidateAndGetService(settings,"ServiceName","WyerpCommunityPG");
    StopDeleteService(erp);
    StopDeleteService(pg);
    string desktop=qa?Path.Combine(qaBase,"shortcuts","desktop"):Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory);
    string menu=qa?Path.Combine(qaBase,"shortcuts","startmenu"):Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms);
    RemoveShortcutIfOwned("网研 ERP.lnk",desktop);
    RemoveShortcutIfOwned("网研 ERP.lnk",menu);
    RemoveShortcutIfOwned("卸载网研 ERP.lnk",menu);
    if(!qa){
     using(var key=Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\WyerpERP-Community",false)){
      if(key!=null && String.Equals(Convert.ToString(key.GetValue("InstallLocation")),root,StringComparison.OrdinalIgnoreCase)){
       Registry.LocalMachine.DeleteSubKeyTree(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\WyerpERP-Community",false);
      }
     }
    }
    Directory.Delete(root,true);
    if(Directory.Exists(root))throw new Exception("Program folder could not be removed");
    BeginInvoke((Action)(()=>{
     label.Text="程序卸载处理中。数据和密码文件保留在："+data;
     if(qa)RecordQa(true,"removed services and program synchronously");
     else {MessageBox.Show(this,"程序已安排清理，您的数据库和API配置会保留。","网研ERP");Close();}
    }));
   }catch(Exception ex){
    BeginInvoke((Action)(()=>{
     label.Text="卸载失败，未删除数据库；请检查错误。";
     if(qa)RecordQa(false,ex.GetType().Name+":"+ex.Message);
     else {remove.Enabled=true;busy=false;MessageBox.Show(this,ex.Message,"卸载失败",MessageBoxButtons.OK,MessageBoxIcon.Error);}
    }));
   }
  });
 }
 protected override void OnFormClosing(FormClosingEventArgs e) {
  if(busy&&!qa){e.Cancel=true;return;}
  base.OnFormClosing(e);
 }
}