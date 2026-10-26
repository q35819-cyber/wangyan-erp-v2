using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Threading;
using System.Security.Cryptography;
using System.Windows.Forms;

internal sealed class WyerpManager : Form
{
    private static Mutex singleton;
    private readonly string installRoot;
    private readonly string controlScript;
    private readonly Label status;
    private readonly Button[] buttons;
    private bool busy;

    [STAThread]
    private static void Main()
    {
        bool created = false;
        // One manager per installation; separately installed instances may coexist.
        string location = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd('\\').ToUpperInvariant();
        byte[] digest;
        using (var sha = SHA256.Create()) digest = sha.ComputeHash(Encoding.UTF8.GetBytes(location));
        string instanceKey = BitConverter.ToString(digest, 0, 12).Replace("-", "");
        singleton = new Mutex(true, @"Local\WyerpCommunityManager-" + instanceKey, out created);
        if (!created)
        {
            MessageBox.Show("这套安装目录的网研 ERP 管理器已打开，请切换到任务栏上现有窗口。关闭此提示不会停止后台。", "网研 ERP");
            singleton.Dispose();
            return;
        }
        try
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new WyerpManager());
        }
        finally
        {
            singleton.ReleaseMutex();
            singleton.Dispose();
        }
    }

    private WyerpManager()
    {
        installRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        controlScript = Path.Combine(installRoot, "installer", "Control.ps1");
        Text = "网研 ERP · 单机管理器";
        ClientSize = new Size(540, 340);
        MinimumSize = MaximumSize = Size;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Microsoft YaHei UI", 9f);
        BackColor = Color.FromArgb(245, 247, 251);

        Controls.Add(new Label {
            Text = "网研 ERP 单机版",
            Font = new Font("Microsoft YaHei UI", 17f, FontStyle.Bold),
            Bounds = new Rectangle(28, 20, 490, 43)
        });
        status = new Label {
            Text = "正在检查本机 ERP 服务…",
            Bounds = new Rectangle(30, 77, 480, 58),
            AutoSize = false,
            ForeColor = Color.FromArgb(55, 65, 81)
        };
        Controls.Add(status);
        var start = MakeButton("启动后台", 28, 146, 145, 43, delegate { RunAction("Start"); });
        var restart = MakeButton("重启后台", 197, 146, 145, 43, delegate { RunAction("Restart"); });
        var stop = MakeButton("关闭后台服务", 366, 146, 145, 43, delegate {
            if (MessageBox.Show(this, "停止后台将中断正在进行的 ERP 操作。确定停止吗？",
                "确认停止", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
                RunAction("Stop");
        });
        var open = MakeButton("打开 ERP 网页", 28, 207, 232, 42, delegate { RunAction("Open"); });
        var plugin = MakeButton("查看 / 安装采集插件", 280, 207, 231, 42, delegate { WyerpPluginGuide.Show(this, installRoot, InvokeControl); });
        buttons = new[] { start, restart, stop, open, plugin };
        Controls.Add(new Label {
            Text = "新安装账号：admin  初始密码：123456（登录需图形验证码）",
            Bounds = new Rectangle(30, 266, 490, 22),
            ForeColor = Color.FromArgb(64, 80, 98)
        });
        Controls.Add(new Label {
            Text = "关闭管理器窗口不会关闭后台；需要停止服务请点“关闭后台服务”。",
            Bounds = new Rectangle(30, 304, 495, 23),
            ForeColor = Color.FromArgb(97, 105, 115)
        });
        Shown += delegate { RunAction("Start"); };
        FormClosing += delegate(object sender, FormClosingEventArgs e) {
            // Never silently stop the ERP and PostgreSQL when closing the UI.
        };
    }

    private Button MakeButton(string title, int x, int y, int w, int h, EventHandler click)
    {
        var button = new Button {
            Text = title, Bounds = new Rectangle(x, y, w, h),
            FlatStyle = FlatStyle.System
        };
        button.Click += click;
        Controls.Add(button);
        return button;
    }

    private void SetBusy(bool active)
    {
        busy = active;
        foreach (var button in buttons) button.Enabled = !active;
    }

    private string InvokeControl(string action)
    {
        if (!File.Exists(controlScript))
            throw new FileNotFoundException("安装目录缺少启动脚本", controlScript);
        var psi = new ProcessStartInfo("powershell.exe") {
            Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" +
                controlScript + "\" -Action " + action + " -InstallRoot \"" + installRoot + "\"",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.Default,
            StandardErrorEncoding = Encoding.Default
        };
        using (var process = Process.Start(psi))
        {
            if (process == null) throw new Exception("Windows 服务控制程序启动失败");
            Task<string> stdout = process.StandardOutput.ReadToEndAsync();
            Task<string> stderr = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(90000))
            {
                try { process.Kill(); } catch {}
                throw new TimeoutException("后台操作等待超过 90 秒");
            }
            Task.WaitAll(stdout, stderr);
            string result = (stdout.Result + Environment.NewLine + stderr.Result).Trim();
            if (process.ExitCode != 0)
                throw new Exception(result.Length > 1200 ? result.Substring(result.Length - 1200) : result);
            return result;
        }
    }

    private void RunAction(string action)
    {
        if (busy) return;
        SetBusy(true);
        status.Text = "正在执行：" + action + " …";
        Task.Run(delegate {
            string message;
            string error = null;
            try { message = InvokeControl(action); }
            catch (Exception ex) { message = null; error = ex.Message; }
            try {
                BeginInvoke((Action)delegate {
                    status.Text = error == null ? ("完成：" + action + "。 " + message) : ("操作失败：" + error);
                    SetBusy(false);
                    if (error != null) MessageBox.Show(this, error, "网研 ERP", MessageBoxButtons.OK, MessageBoxIcon.Error);
                });
            }
            catch (InvalidOperationException) {}
        });
    }
}
