using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text.RegularExpressions;
using System.Windows.Forms;

internal static class WyerpPluginGuide
{
    public static void Show(Form owner, string installRoot, Func<string,string> runControl)
    {
        string folder=Path.Combine(installRoot,"collector","wyerp-collector");
        string manifest=Path.Combine(folder,"manifest.json");
        if (!File.Exists(manifest)) {
            MessageBox.Show(owner,"插件目录缺失："+folder+"\n请重新安装完整安装包。","采集插件缺失");
            return;
        }
        string version="未知";
        try {
            var m=Regex.Match(File.ReadAllText(manifest), "\"version\"\\s*:\\s*\"([0-9.]+)\"");
            if(m.Success) version=m.Groups[1].Value;
        } catch { }
        using (var f=new Form()) {
            f.Text="网研ERP · 安装采集插件";
            f.ClientSize=new Size(760,515);
            f.MinimumSize=f.MaximumSize=f.Size;
            f.StartPosition=FormStartPosition.CenterParent;
            f.ShowInTaskbar=false;
            f.Font=new Font("Microsoft YaHei UI",9.5f);
            f.BackColor=Color.White;
            f.Controls.Add(new Label {Text="采集插件已经包含在本机安装包内（v"+version+"）",
                Font=new Font("Microsoft YaHei UI",14f,FontStyle.Bold),Bounds=new Rectangle(20,16,712,36)});
            f.Controls.Add(new Label {Text="浏览器不能静默安装扩展。首次加载需你在 Edge / Chrome 中确认一次。",
                Bounds=new Rectangle(20,61,712,26)});
            var steps=new TextBox {ReadOnly=true,Multiline=true,ScrollBars=ScrollBars.Vertical,
                Bounds=new Rectangle(20,102,712,162),
                Text="1. 点击“打开 Edge 扩展页”或“打开 Chrome 扩展页”。\r\n"
                    +"2. 在扩展管理页开启“开发人员模式”。\r\n"
                    +"3. 点击“加载解压缩的扩展”或“加载已解压的扩展程序”。\r\n"
                    +"4. 点击下面“复制插件路径”，在选择文件夹的窗口粘贴并确认。\r\n"
                    +"5. 固定工具栏的“网研ERP采集助手”，登录 ERP 后手动采集商品。"};
            f.Controls.Add(steps);
            f.Controls.Add(new Label {Text="插件文件夹路径：",Bounds=new Rectangle(20,274,712,25)});
            var path=new TextBox {ReadOnly=true,Text=folder,Bounds=new Rectangle(20,302,712,31)};
            f.Controls.Add(path);
            Add(f,"打开 Edge 扩展页",20,347,225,delegate { OpenBrowser(f,"Edge"); });
            Add(f,"打开 Chrome 扩展页",266,347,225,delegate { OpenBrowser(f,"Chrome"); });
            Add(f,"打开插件文件夹",512,347,220,delegate {
                try{Process.Start("explorer.exe","\"" + folder + "\"");}
                catch(Exception e){MessageBox.Show(f,e.Message,"打开目录失败");}
            });
            Add(f,"复制插件路径",20,411,225,delegate {
                try{Clipboard.SetText(folder);path.Focus();path.SelectAll();}
                catch(Exception e){MessageBox.Show(f,e.Message,"复制失败");}
            });
            Add(f,"检查插件文件",266,411,225,delegate {
                try{MessageBox.Show(f,runControl("PluginCheck"),"文件校验",MessageBoxButtons.OK,MessageBoxIcon.Information);}
                catch(Exception e){MessageBox.Show(f,e.Message,"校验失败",MessageBoxButtons.OK,MessageBoxIcon.Error);}
            });
            Add(f,"关闭指引",512,411,220,delegate {f.Close();});
            f.Controls.Add(new Label {Text="提示：仅打开扩展页不会自动安装；需在浏览器中完成加载。",
                Bounds=new Rectangle(20,475,712,26)});
            f.ShowDialog(owner);
        }
    }
    private static void Add(Form form,string label,int x,int y,int width,EventHandler action) {
        var b=new Button{Text=label,Bounds=new Rectangle(x,y,width,45),FlatStyle=FlatStyle.System};
        b.Click+=action;form.Controls.Add(b);
    }
    private static void OpenBrowser(Form owner,string browser) {
        string address=browser=="Edge"?"edge://extensions/":"chrome://extensions/";
        string file=browser=="Edge"?"msedge.exe":"chrome.exe";
        string relative=browser=="Edge"?@"Microsoft\Edge\Application\msedge.exe":@"Google\Chrome\Application\chrome.exe";
        string[] roots={Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)};
        foreach(string root in roots) {
            if(String.IsNullOrEmpty(root))continue;
            string candidate=Path.Combine(root,relative);
            if(File.Exists(candidate)){file=candidate;break;}
        }
        try{Process.Start(new ProcessStartInfo {FileName=file,Arguments=address,UseShellExecute=true});}
        catch(Exception e){MessageBox.Show(owner,"打开浏览器失败："+e.Message+"\n也可以直接在浏览器地址栏输入："+address,"打开扩展页失败");}
    }
}