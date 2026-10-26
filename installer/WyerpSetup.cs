using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Windows.Forms;
using System.Drawing;
using System.Security.Principal;
using System.Threading.Tasks;
using Microsoft.Win32;

internal sealed class WyerpSetup : Form {
  readonly TextBox program = new TextBox(), data = new TextBox();
  readonly TextBox log = new TextBox();
  readonly Button install = new Button();
  readonly CheckBox recovery = new CheckBox();
  const string ProgramFolder = "WyerpERP-Community";
  const string DataFolder = "WyerpERP-Community";
  public WyerpSetup() {
    Text = "网研 ERP 单机版安装向导 preview30"; Width=710; Height=480;
    FormBorderStyle=FormBorderStyle.FixedDialog; MaximizeBox=false; StartPosition=FormStartPosition.CenterScreen;
    Font=new Font("Microsoft YaHei UI",9);
    var intro=new Label {Left=18,Top=15,Width=660,Height=42,Text="可分别选择程序安装位置和本机数据存储位置。首次安装无需旧安装记录。\r\n旧数据库不会自动覆盖、移动或删除。"};
    Controls.Add(intro);
    AddPath("程序安装目录：",program,65,Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),ProgramFolder));
    AddPath("数据存储目录：",data,130,Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),DataFolder));
    recovery.Left=20; recovery.Top=196; recovery.Width=650; recovery.Height=46;
    recovery.Text="恢复原安装（仅旧程序已卸载、数据和安装记录完整时使用）";
    Controls.Add(recovery);
    install.Text="开始安装"; install.Left=20; install.Top=249; install.Width=120; install.Height=38;
    install.Click += async (s,e) => await Install();
    Controls.Add(install);
    log.Left=20;log.Top=301;log.Width=650;log.Height=125;log.Multiline=true;log.ReadOnly=true;log.ScrollBars=ScrollBars.Vertical;
    Controls.Add(log);
  }
  void AddPath(string label,TextBox input,int y,string value) {
    Controls.Add(new Label {Left=20,Top=y,Width=640,Height=24,Text=label});
    input.Left=20;input.Top=y+26;input.Width=535;input.Text=value; Controls.Add(input);
    var browse=new Button {Text="浏览...",Left=565,Top=y+25,Width=103,Height=28};
    browse.Click+=(s,e)=>{using(var pick=new FolderBrowserDialog()){pick.Description=label;pick.SelectedPath=Directory.Exists(input.Text)?input.Text:Path.GetPathRoot(input.Text);if(pick.ShowDialog(this)==DialogResult.OK)input.Text=pick.SelectedPath;}};
    Controls.Add(browse);
  }
  static string Full(string value) {
    if(String.IsNullOrWhiteSpace(value)||!Path.IsPathRooted(value))throw new InvalidOperationException("必须选择完整的绝对目录路径。");
    var p=Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar);
    if(p.Length<4)throw new InvalidOperationException("不能把整个磁盘根目录作为安装或数据目录。");
    return p;
  }
  static bool Contained(string inner,string outer) {
    return inner.StartsWith(outer.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase)||String.Equals(inner,outer,StringComparison.OrdinalIgnoreCase);
  }
  static bool HasFiles(string p) {
    return Directory.Exists(p)&&Directory.EnumerateFileSystemEntries(p).GetEnumerator().MoveNext();
  }
  static void Check(string root,string d,bool restore) {
    if(Contained(d,root)||Contained(root,d))throw new InvalidOperationException("程序与数据目录必须分开，不能互相包含。");
    if(!restore) {
      if(HasFiles(root))throw new InvalidOperationException("程序目录非空，为避免覆盖旧程序，请选一个新的空目录。");
      if(Directory.Exists(d))throw new InvalidOperationException("数据目录已存在。为保护原数据库，请重新选择新的数据目录；恢复旧数据请选择恢复模式。");
    }else{
      if(HasFiles(root))throw new InvalidOperationException("恢复模式要求程序已经卸载，目标程序目录必须为空。");
      var cfg=Path.Combine(d,"install-settings.json");
      var needed=new[]{cfg,Path.Combine(d,"secrets","wyerp.env"),Path.Combine(d,"secrets","credentials.key"),Path.Combine(d,"runtime","postgresql","PG_VERSION")};
      foreach(var f in needed)if(!File.Exists(f))throw new InvalidOperationException("恢复必要文件缺失，未修改数据："+f);
      // Actual ownership, credentials and service validation remains in Recover-Existing.ps1.
    }
  }
  static void ExtractSafely(ZipArchive z,string destination) {
    foreach(var item in z.Entries){
      var target=Path.GetFullPath(Path.Combine(destination,item.FullName.Replace('/',Path.DirectorySeparatorChar)));
      if(!target.StartsWith(destination.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase))
        throw new InvalidDataException("安装包内发现不安全路径。");
      if(String.IsNullOrEmpty(item.Name)){Directory.CreateDirectory(target);continue;}
      Directory.CreateDirectory(Path.GetDirectoryName(target));
      using(var input=item.Open())using(var output=new FileStream(target,FileMode.CreateNew,FileAccess.Write))input.CopyTo(output);
    }
  }
  async Task Install(){
    if(!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)) {
      MessageBox.Show(this,"请使用管理员权限运行安装包。","权限不足");return;
    }
    string root,d; bool restore=recovery.Checked;
    try{root=Full(program.Text);d=Full(data.Text);Check(root,d,restore);}
    catch(Exception ex){MessageBox.Show(this,ex.Message,"安装前检查");return;}
    install.Enabled=false;log.Text="正在解包并运行本机初始化，请勿关闭安装器。\r\n";
    try{
      await Task.Run(()=>{
        Directory.CreateDirectory(root);
        var asm=typeof(WyerpSetup).Assembly;
        using(var payload=asm.GetManifestResourceStream("WyerpPayload.zip")){
          if(payload==null)throw new InvalidDataException("安装器缺少内置程序文件。");
          using(var archive=new ZipArchive(payload,ZipArchiveMode.Read))ExtractSafely(archive,root);
        }
        var script=Path.Combine(root,"installer",restore?"Recover-Existing.ps1":"Initialize.ps1");
        if(!File.Exists(script))throw new FileNotFoundException("安装器缺少初始化脚本",script);
        var psi=new ProcessStartInfo("powershell.exe"){
          Arguments="-NoProfile -ExecutionPolicy Bypass -File \""+script+"\" -InstallRoot \""+root+"\" -DataRoot \""+d+"\"",
          UseShellExecute=false,RedirectStandardOutput=true,RedirectStandardError=true,CreateNoWindow=true
        };
        using(var p=Process.Start(psi)){
          var outputTask=p.StandardOutput.ReadToEndAsync();
          var errorTask=p.StandardError.ReadToEndAsync();
          p.WaitForExit();
          var stdout=outputTask.Result;var stderr=errorTask.Result;
          if(p.ExitCode!=0)throw new InvalidOperationException("初始化未通过（退出码 "+p.ExitCode+"）：\r\n"+Tail(stdout+"\r\n"+stderr));
        }
      });
      log.AppendText("安装成功。可从安装目录运行 WyerpERP-Manager.exe。\r\n");
      MessageBox.Show(this,"安装完成。原有其他实例及数据库未被清理。","安装完成");
    }catch(Exception ex) {
      log.AppendText(ex.Message+"\r\n");
      MessageBox.Show(this,"安装未完成："+ex.Message+"\r\n已创建的程序文件未自动删除，以避免误删旧数据。","安装失败");
    }finally{install.Enabled=true;}
  }
  static string Tail(string t){return t.Length>2500?t.Substring(t.Length-2500):t;}
  [STAThread]static void Main(){Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Application.Run(new WyerpSetup());}
}
