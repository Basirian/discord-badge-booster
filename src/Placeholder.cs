using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.Text;
using System.Windows.Forms;

// This executable has no network, Discord, credential, or game integration code.
// The launcher copies it under a selected executable name and runs it as a child.
internal static class Placeholder
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            int parentId;
            long parentStart;
            string parentText = Value(args, "--local-parent");
            string startText = Value(args, "--local-parent-start");
            string titleText = Value(args, "--local-title");
            if (!int.TryParse(parentText, out parentId) ||
                !long.TryParse(startText, NumberStyles.Integer, CultureInfo.InvariantCulture, out parentStart))
                return 2;
            string game = Encoding.UTF8.GetString(Convert.FromBase64String(titleText));
            using (Process parent = Process.GetProcessById(parentId))
            {
                if (parent.StartTime.ToUniversalTime().Ticks != parentStart || parent.HasExited)
                    return 3;
                Application.EnableVisualStyles();
                using (Form window = new Form())
                using (Timer monitor = new Timer())
                {
                    window.Text = "Local placeholder - " + game;
                    window.ClientSize = new Size(430, 115);
                    window.StartPosition = FormStartPosition.CenterScreen;
                    window.FormBorderStyle = FormBorderStyle.FixedDialog;
                    window.MaximizeBox = false;
                    window.WindowState = FormWindowState.Minimized;
                    window.Controls.Add(new Label {
                        Text = "Local placeholder for " + game + "\r\n\r\nNo game is running. Close this window to stop the placeholder.",
                        Dock = DockStyle.Fill, Padding = new Padding(16), AutoEllipsis = true
                    });
                    monitor.Interval = 1000;
                    monitor.Tick += delegate {
                        try { if (parent.HasExited) window.Close(); }
                        catch { window.Close(); }
                    };
                    monitor.Start();
                    Application.Run(window);
                }
            }
            return 0;
        }
        catch { return 3; }
    }

    private static string Value(string[] args, string name)
    {
        for (int i = 0; i + 1 < args.Length; i++)
            if (args[i] == name) return args[i + 1];
        return "";
    }
}
