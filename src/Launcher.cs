using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

public sealed class ExecutableEntry
{
    public string path { get; set; }
    public string arguments { get; set; }
    public override string ToString() { return path + (string.IsNullOrEmpty(arguments) ? "" : " " + arguments); }
}

public sealed class GameEntry
{
    public string id { get; set; }
    public string name { get; set; }
    public List<ExecutableEntry> executables { get; set; }
    public override string ToString() { return name; }
}

public sealed class Catalog
{
    public string source { get; set; }
    public string downloadedAtUtc { get; set; }
    public List<GameEntry> games { get; set; }
}

public static class LocalFiles
{
    public static string SafePath(string root, string id, string relative)
    {
        if (string.IsNullOrEmpty(id) || id.Any(c => c < '0' || c > '9'))
            throw new ArgumentException("Invalid game ID.");
        if (string.IsNullOrEmpty(relative) || Path.IsPathRooted(relative))
            throw new ArgumentException("An executable must have a relative path.");
        string[] parts = relative.Replace('\\', '/').Split('/');
        foreach (string part in parts)
        {
            string device = part.Split('.')[0].ToUpperInvariant();
            if (part.Length == 0 || part == "." || part == ".." ||
                part.EndsWith(".") || part.EndsWith(" ") ||
                part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                new[] { "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$" }.Contains(device) ||
                (device.Length == 4 && (device.StartsWith("COM") || device.StartsWith("LPT")) &&
                 device[3] >= '1' && device[3] <= '9'))
                throw new ArgumentException("Unsupported executable path.");
        }
        if (!relative.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Only Windows executable names are supported.");
        string gameRoot = Path.GetFullPath(Path.Combine(root, id));
        string full = Path.GetFullPath(Path.Combine(gameRoot, Path.Combine(parts)));
        if (!full.StartsWith(gameRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Executable path is outside the local game folder.");
        // Refuse junctions/symlinks so an existing folder cannot redirect writes.
        DirectoryInfo cursor = new DirectoryInfo(Path.GetDirectoryName(full));
        while (cursor != null)
        {
            if (cursor.Exists && (cursor.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException("The local game path contains a junction or symbolic link.");
            cursor = cursor.Parent;
        }
        if (File.Exists(full) && (File.GetAttributes(full) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("The executable path is a symbolic link.");
        return full;
    }

    public static Catalog ReadCatalog()
    {
        using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("games.json"))
        using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
            Catalog catalog = serializer.Deserialize<Catalog>(reader.ReadToEnd());
            if (catalog == null || catalog.games == null || catalog.games.Count == 0)
                throw new InvalidDataException("The bundled game catalog is empty.");
            return catalog;
        }
    }

    public static void WritePlaceholder(string target)
    {
        using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream("Placeholder.exe"))
        {
            byte[] expected;
            using (MemoryStream memory = new MemoryStream()) { source.CopyTo(memory); expected = memory.ToArray(); }
            if (File.Exists(target))
            {
                if (!File.ReadAllBytes(target).SequenceEqual(expected))
                    throw new IOException("A different file already exists at the placeholder path. It was not changed.");
                return;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            // CreateNew will never overwrite an existing file.
            using (FileStream output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                output.Write(expected, 0, expected.Length);
        }
    }
}

internal static class Native
{
    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
}

// Hosts the HTML interface (ui/) in WebView2. The page only renders state; this class owns the
// placeholder process, the auto rotation, and the files under %LOCALAPPDATA%\BadgeBooster.
internal sealed class Launcher : Form
{
    private const string RepositoryUrl = "https://github.com/Basirian/discord-badge-booster";
    private const string Origin = "https://app.local/";
    private static readonly Dictionary<string, string> pages = new Dictionary<string, string> {
        { "index.html", "text/html; charset=utf-8" }, { "app.css", "text/css; charset=utf-8" },
        { "app.js", "text/javascript; charset=utf-8" }, { "games.json", "application/json; charset=utf-8" },
        { "logo.png", "image/png" }, { "badge-variety.svg", "image/svg+xml" }, { "badge-time.svg", "image/svg+xml" }
    };

    private readonly Catalog catalog;
    private readonly Dictionary<string, GameEntry> byId = new Dictionary<string, GameEntry>();
    private readonly WebView2 view = new WebView2();
    private readonly Timer timer = new Timer();
    private readonly Random random = new Random();
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    private static readonly string DataRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BadgeBooster");
    private readonly string dataRoot = DataRoot, gameRoot, historyPath, settingsPath, statsPath;
    // IDs of games auto rotate already played. Persisted so a rotation never repeats a game.
    private readonly HashSet<string> played = new HashSet<string>();

    private CoreWebView2Environment environment;
    private bool pageReady;
    private Process worker;
    private GameEntry runningGame;
    private ExecutableEntry runningExe;
    private DateTime started;
    // Whether the running placeholder was started by Game Variety, captured at start so playtime is credited correctly.
    private bool runningAuto;
    // Playtime totals, tracked from the first run of this version onward.
    private double varietySeconds, gameTimeSeconds, longestSeconds;
    private int sessions;
    // Games played before playtime tracking existed, and their estimated time (from the range set back then).
    private int legacyGames = -1;
    private double legacySeconds;
    private DateTime trackingSince = DateTime.UtcNow;
    private bool autoRunning;
    // Set when a rotation ends because every game in its pool was played; cleared by the next start.
    private bool rotationCompleted;
    private List<GameEntry> autoQueue = new List<GameEntry>();
    private int autoPos, quickExits;
    // Each auto game runs for a random length between these bounds, rolled again for every game.
    private int minMinutes = 10, maxMinutes = 15;
    private TimeSpan autoDuration;
    private string order = "random";
    private bool onlyMatches;

    public Launcher()
    {
        catalog = LocalFiles.ReadCatalog();
        foreach (GameEntry game in catalog.games)
            if (game.executables != null && game.executables.Count > 0 && !byId.ContainsKey(game.id)) byId[game.id] = game;
        gameRoot = Path.Combine(dataRoot, "games");
        historyPath = Path.Combine(dataRoot, "rotation-history.txt");
        settingsPath = Path.Combine(dataRoot, "settings.txt");
        statsPath = Path.Combine(dataRoot, "stats.txt");
        LoadHistory();
        LoadSettings();
        LoadStats();

        float scale = 1f;
        using (Graphics g = CreateGraphics()) scale = Math.Max(1f, g.DpiX / 96f);
        Text = "Badge Booster";
        BackColor = Color.FromArgb(0x09, 0x09, 0x0B);
        ClientSize = new Size((int)(1240 * scale), (int)(820 * scale));
        MinimumSize = new Size((int)(1000 * scale), (int)(680 * scale));
        StartPosition = FormStartPosition.CenterScreen;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        view.Dock = DockStyle.Fill;
        view.DefaultBackgroundColor = BackColor;
        Controls.Add(view);

        timer.Interval = 500;
        timer.Tick += delegate { Tick(); };
        timer.Start();
        Load += async delegate { await InitializeView(); };
        FormClosing += delegate { autoRunning = false; StopWorker(); };
        FormClosed += delegate { timer.Dispose(); };
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        try
        {
            // Dark title bar (attribute 20, or 19 on older Windows 10) and a caption that matches the page on Windows 11.
            int on = 1;
            if (Native.DwmSetWindowAttribute(Handle, 20, ref on, 4) != 0) Native.DwmSetWindowAttribute(Handle, 19, ref on, 4);
            int caption = ColorTranslator.ToWin32(Color.FromArgb(0x0C, 0x0C, 0x0E));
            Native.DwmSetWindowAttribute(Handle, 35, ref caption, 4);
        }
        catch { }
    }

    private async Task InitializeView()
    {
        try
        {
            // The page is served from embedded resources; nothing is loaded from the network.
            CoreWebView2EnvironmentOptions options = new CoreWebView2EnvironmentOptions(
                "--disable-background-networking --disable-component-update --disable-sync --no-pings " +
                "--disable-features=msSmartScreenProtection,AutofillServerCommunication");
            environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(dataRoot, "webview"), options);
            await view.EnsureCoreWebView2Async(environment);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, "The Microsoft Edge WebView2 Runtime is required to show this window. It is included with " +
                "Windows 11 and can be installed from Microsoft.\r\n\r\n" + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return;
        }
        CoreWebView2 core = view.CoreWebView2;
        CoreWebView2Settings settings = core.Settings;
        settings.AreDefaultContextMenusEnabled = false;
        settings.AreDevToolsEnabled = Environment.GetEnvironmentVariable("DISCORD_LOCAL_GAME_DEVTOOLS") == "1";
        settings.IsZoomControlEnabled = false;
        settings.IsStatusBarEnabled = false;
        settings.AreBrowserAcceleratorKeysEnabled = false;
        settings.IsPasswordAutosaveEnabled = false;
        settings.IsGeneralAutofillEnabled = false;
        settings.IsReputationCheckingRequired = false;
        core.AddWebResourceRequestedFilter(Origin + "*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += ServePage;
        core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) {
            if (!e.Uri.StartsWith(Origin, StringComparison.Ordinal)) e.Cancel = true;
        };
        core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; };
        core.WebMessageReceived += OnMessage;
        core.Navigate(Origin + "index.html");
    }

    private void ServePage(object sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        string name = new Uri(e.Request.Uri).AbsolutePath.TrimStart('/');
        if (name.Length == 0) name = "index.html";
        string type;
        Stream source = pages.TryGetValue(name, out type)
            ? Assembly.GetExecutingAssembly().GetManifestResourceStream(name == "games.json" ? name : "ui/" + name)
            : null;
        if (source == null) { e.Response = environment.CreateWebResourceResponse(null, 404, "Not Found", ""); return; }
        MemoryStream body = new MemoryStream();
        using (source) source.CopyTo(body);
        body.Position = 0;
        e.Response = environment.CreateWebResourceResponse(body, 200, "OK", "Content-Type: " + type + "\r\nCache-Control: no-store");
    }

    private void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!e.Source.StartsWith(Origin, StringComparison.Ordinal)) return;
        Dictionary<string, object> message;
        try { message = json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson); }
        catch { return; }
        if (message == null) return;
        switch (Get(message, "type") as string)
        {
            case "ready":
                pageReady = true;
                PushState();
                break;
            case "start":
                StartManual(Get(message, "id") as string, ToInt(Get(message, "exe"), 0));
                break;
            case "stop":
                autoRunning = false;
                StopWorker();
                PushState();
                break;
            case "dismissCompleted":
                rotationCompleted = false;
                PushState();
                break;
            case "skip":
                if (autoRunning) { quickExits = 0; AdvanceAuto(); }
                break;
            case "settings":
                ApplySettings(message);
                PushState();
                break;
            case "rotate":
                ApplySettings(message);
                StartRotation(Get(message, "ids") as System.Collections.IEnumerable);
                break;
            case "resetHistory":
                ResetHistory();
                break;
            case "openRepo":
                try { Process.Start(new ProcessStartInfo(RepositoryUrl) { UseShellExecute = true }); }
                catch (Exception ex) { Notify(ex.Message, "error"); }
                break;
            case "openFolder":
                try { Directory.CreateDirectory(gameRoot); Process.Start("explorer.exe", "\"" + gameRoot + "\""); }
                catch (Exception ex) { Notify(ex.Message, "error"); }
                break;
        }
    }

    private static object Get(Dictionary<string, object> message, string key)
    {
        object value;
        return message.TryGetValue(key, out value) ? value : null;
    }

    private static int ToInt(object value, int fallback)
    {
        if (value is int) return (int)value;
        if (value is decimal) return (int)(decimal)value;
        if (value is double) return (int)(double)value;
        return fallback;
    }

    private void ApplySettings(Dictionary<string, object> message)
    {
        SetRange(ToInt(Get(message, "minMinutes"), minMinutes), ToInt(Get(message, "maxMinutes"), maxMinutes));
        // A new range also applies to the current game if its rolled length no longer fits.
        if (autoRunning && (autoDuration < TimeSpan.FromMinutes(minMinutes) || autoDuration > TimeSpan.FromMinutes(maxMinutes)))
            autoDuration = RollDuration();
        string requestedOrder = Get(message, "order") as string;
        if (!autoRunning && (requestedOrder == "random" || requestedOrder == "alpha")) order = requestedOrder;
        if (!autoRunning && Get(message, "onlyMatches") is bool) onlyMatches = (bool)Get(message, "onlyMatches");
        SaveSettings();
    }

    private void SetRange(int low, int high)
    {
        low = Math.Max(1, Math.Min(1440, low));
        high = Math.Max(1, Math.Min(1440, high));
        minMinutes = Math.Min(low, high);
        maxMinutes = Math.Max(low, high);
    }

    private TimeSpan RollDuration()
    {
        return TimeSpan.FromSeconds(random.Next(minMinutes * 60, maxMinutes * 60 + 1));
    }

    private void StartManual(string id, int exeIndex)
    {
        GameEntry game;
        if (id == null || !byId.TryGetValue(id, out game)) return;
        ExecutableEntry entry = game.executables[Math.Max(0, Math.Min(game.executables.Count - 1, exeIndex))];
        if (worker != null && runningGame == game && runningExe == entry && !autoRunning) return;
        autoRunning = false;
        rotationCompleted = false;
        if (!StopWorker()) { PushState(); return; }
        string error = TryStart(game, entry);
        PushState();
        if (error != null) Notify("Could not start " + game.name + ": " + error, "error");
    }

    private void StartRotation(System.Collections.IEnumerable ids)
    {
        if (autoRunning) return;
        IEnumerable<GameEntry> source = byId.Values;
        if (onlyMatches && ids != null)
        {
            List<GameEntry> chosen = new List<GameEntry>();
            foreach (object item in ids)
            {
                GameEntry game;
                string id = item as string;
                if (id != null && byId.TryGetValue(id, out game)) chosen.Add(game);
            }
            source = chosen;
        }
        List<GameEntry> pool = source.Where(g => !played.Contains(g.id)).Distinct().ToList();
        if (pool.Count == 0) { Notify("Every game in this pool has already been rotated.", "info"); PushState(); return; }
        if (order == "alpha")
            pool = pool.OrderBy(g => g.name, StringComparer.CurrentCultureIgnoreCase).ToList();
        else
            for (int i = pool.Count - 1; i > 0; i--)
            {
                int j = random.Next(i + 1);
                GameEntry swap = pool[i]; pool[i] = pool[j]; pool[j] = swap;
            }
        autoQueue = pool;
        autoPos = -1;
        rotationCompleted = false;
        quickExits = 0;
        autoRunning = true;
        AdvanceAuto();
    }

    // Stops the current game and starts the next unplayed one. Each game is recorded before it starts,
    // so a game that fails, closes, or is skipped is never picked again.
    private void AdvanceAuto()
    {
        if (!StopWorker()) { autoRunning = false; PushState(); return; }
        int failures = 0;
        while (autoRunning && ++autoPos < autoQueue.Count)
        {
            GameEntry next = autoQueue[autoPos];
            if (played.Contains(next.id)) continue;
            MarkPlayed(next);
            string error = TryStart(next, next.executables[0]);
            if (error == null) { autoDuration = RollDuration(); PushState(); return; }
            Notify("Skipped " + next.name + ": " + error, "warning");
            if (++failures >= 3)
            {
                autoRunning = false;
                Notify("Game Variety stopped because three games in a row failed to start.", "error");
            }
        }
        if (autoRunning)
        {
            autoRunning = false;
            rotationCompleted = true;
            Notify("Game Variety complete. Every game in the pool has been played once.", "success");
        }
        PushState();
    }

    private string TryStart(GameEntry game, ExecutableEntry entry)
    {
        try
        {
            string path = LocalFiles.SafePath(gameRoot, game.id, entry.path);
            LocalFiles.WritePlaceholder(path);
            using (Process self = Process.GetCurrentProcess())
            {
                string encodedTitle = Convert.ToBase64String(Encoding.UTF8.GetBytes(game.name));
                string args = (entry.arguments ?? "") + " --local-parent " + self.Id +
                    " --local-parent-start " + self.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) +
                    " --local-title " + encodedTitle;
                // No shell, game launcher, injection, Discord API, or downloaded executable.
                worker = Process.Start(new ProcessStartInfo(path, args) {
                    UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(path)
                });
            }
            started = DateTime.UtcNow;
            runningGame = game;
            runningExe = entry;
            runningAuto = autoRunning;
            return null;
        }
        catch (Exception ex)
        {
            StopWorker();
            return ex.Message;
        }
    }

    private bool StopWorker()
    {
        if (worker != null)
        {
            try
            {
                if (!worker.HasExited)
                {
                    worker.CloseMainWindow();
                    if (!worker.WaitForExit(1500)) { worker.Kill(); worker.WaitForExit(1500); }
                }
            }
            catch (InvalidOperationException) { }
            catch (Exception ex) { Notify("Could not stop the placeholder: " + ex.Message, "error"); return false; }
            worker.Dispose();
            worker = null;
            if (runningGame != null) RecordPlaytime(DateTime.UtcNow - started, runningAuto);
        }
        runningGame = null;
        runningExe = null;
        return true;
    }

    private void Tick()
    {
        if (worker == null) return;
        bool exited;
        try { exited = worker.HasExited; }
        catch { exited = true; }
        if (exited)
        {
            string name = runningGame.name;
            bool quick = DateTime.UtcNow - started < TimeSpan.FromSeconds(5);
            StopWorker();
            if (!autoRunning) { Notify("The placeholder for " + name + " was closed.", "info"); PushState(); return; }
            quickExits = quick ? quickExits + 1 : 0;
            if (quickExits >= 3)
            {
                autoRunning = false;
                Notify("Game Variety stopped because the placeholder closed right after starting three times in a row.", "error");
                PushState();
                return;
            }
            Notify("The placeholder for " + name + " closed early, so Game Variety moved on.", "warning");
            AdvanceAuto();
            return;
        }
        if (autoRunning && DateTime.UtcNow - started >= autoDuration)
        {
            quickExits = 0;
            AdvanceAuto();
        }
    }

    private static long UnixMs(DateTime utc) { return (long)(utc - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }

    private void PushState()
    {
        if (!pageReady || view.CoreWebView2 == null) return;
        Dictionary<string, object> running = null;
        if (worker != null && runningGame != null)
            running = new Dictionary<string, object> {
                { "id", runningGame.id }, { "name", runningGame.name }, { "exe", runningExe.ToString() },
                { "exeIndex", runningGame.executables.IndexOf(runningExe) }, { "startedAt", UnixMs(started) },
                { "duration", autoRunning ? (long)autoDuration.TotalMilliseconds : 0 }
            };
        List<object> upNext = new List<object>();
        for (int i = autoPos + 1; autoRunning && i < autoQueue.Count && upNext.Count < 5; i++)
            if (!played.Contains(autoQueue[i].id))
                upNext.Add(new Dictionary<string, object> { { "id", autoQueue[i].id }, { "name", autoQueue[i].name } });
        Post(new Dictionary<string, object> {
            { "type", "state" },
            { "running", running },
            { "auto", new Dictionary<string, object> {
                { "active", autoRunning }, { "completed", rotationCompleted }, { "position", autoPos + 1 }, { "total", autoQueue.Count }, { "next", upNext } } },
            { "settings", new Dictionary<string, object> { { "minMinutes", minMinutes }, { "maxMinutes", maxMinutes }, { "order", order }, { "onlyMatches", onlyMatches } } },
            { "played", played.ToArray() },
            { "stats", new Dictionary<string, object> {
                { "varietySeconds", (long)varietySeconds }, { "gameTimeSeconds", (long)gameTimeSeconds },
                { "longestSeconds", (long)longestSeconds }, { "sessions", sessions }, { "since", UnixMs(trackingSince) },
                { "legacyGames", Math.Max(0, legacyGames) }, { "legacySeconds", (long)legacySeconds } } }
        });
    }

    private void Notify(string text, string level)
    {
        Post(new Dictionary<string, object> { { "type", "notice" }, { "text", text }, { "level", level } });
    }

    private void Post(object message)
    {
        if (!pageReady || view.CoreWebView2 == null) return;
        try { view.CoreWebView2.PostWebMessageAsJson(json.Serialize(message)); }
        catch (Exception) { }
    }

    private void MarkPlayed(GameEntry game)
    {
        if (!played.Add(game.id)) return;
        try
        {
            Directory.CreateDirectory(dataRoot);
            File.AppendAllText(historyPath, game.id + Environment.NewLine);
        }
        catch (Exception ex) { Notify("Could not save the rotation history: " + ex.Message, "warning"); }
    }

    private void LoadHistory()
    {
        try
        {
            if (!File.Exists(historyPath)) return;
            foreach (string line in File.ReadAllLines(historyPath))
            {
                string id = line.Trim();
                if (id.Length > 0 && id.All(c => c >= '0' && c <= '9')) played.Add(id);
            }
        }
        catch { }
    }

    private void ResetHistory()
    {
        if (autoRunning) return;
        try
        {
            if (File.Exists(historyPath)) File.Delete(historyPath);
            played.Clear();
            Notify("Rotation history cleared.", "success");
        }
        catch (Exception ex) { Notify("Could not clear the rotation history: " + ex.Message, "error"); }
        PushState();
    }

    private void RecordPlaytime(TimeSpan elapsed, bool auto)
    {
        double seconds = Math.Max(0, elapsed.TotalSeconds);
        if (auto) varietySeconds += seconds; else gameTimeSeconds += seconds;
        longestSeconds = Math.Max(longestSeconds, seconds);
        sessions++;
        SaveStats();
    }

    private void LoadStats()
    {
        try
        {
            if (File.Exists(statsPath))
                foreach (string line in File.ReadAllLines(statsPath))
                {
                    int split = line.IndexOf('=');
                    if (split < 0) continue;
                    string key = line.Substring(0, split).Trim(), value = line.Substring(split + 1).Trim();
                    double number;
                    if (!double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out number) || number < 0) continue;
                    if (key == "varietySeconds") varietySeconds = number;
                    else if (key == "gameTimeSeconds") gameTimeSeconds = number;
                    else if (key == "longestSeconds") longestSeconds = number;
                    else if (key == "sessions") sessions = (int)number;
                    else if (key == "since") trackingSince = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(number);
                    else if (key == "legacyGames") legacyGames = (int)number;
                    else if (key == "legacySeconds") legacySeconds = number;
                }
        }
        catch { }
        if (legacyGames < 0)
        {
            legacyGames = Math.Max(0, played.Count - sessions);
            legacySeconds = legacyGames * (minMinutes + maxMinutes) / 2.0 * 60;
            SaveStats();
        }
    }

    private void SaveStats()
    {
        try
        {
            Directory.CreateDirectory(dataRoot);
            File.WriteAllText(statsPath, string.Format(CultureInfo.InvariantCulture,
                "varietySeconds={0:0}\r\ngameTimeSeconds={1:0}\r\nlongestSeconds={2:0}\r\nsessions={3}\r\nsince={4}\r\nlegacyGames={5}\r\nlegacySeconds={6:0}\r\n",
                varietySeconds, gameTimeSeconds, longestSeconds, sessions, UnixMs(trackingSince), Math.Max(0, legacyGames), legacySeconds));
        }
        catch { }
    }

    private void LoadSettings()
    {
        try
        {
            if (!File.Exists(settingsPath)) return;
            foreach (string line in File.ReadAllLines(settingsPath))
            {
                int split = line.IndexOf('=');
                if (split < 0) continue;
                string key = line.Substring(0, split).Trim(), value = line.Substring(split + 1).Trim();
                int number;
                bool isNumber = int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out number);
                if (key == "minMinutes" && isNumber) SetRange(number, maxMinutes);
                else if (key == "maxMinutes" && isNumber) SetRange(minMinutes, number);
                else if (key == "minutes" && isNumber) SetRange(number, number);
                else if (key == "order" && (value == "random" || value == "alpha")) order = value;
                else if (key == "onlyMatches") onlyMatches = value == "1";
            }
        }
        catch { }
    }

    private void SaveSettings()
    {
        try
        {
            Directory.CreateDirectory(dataRoot);
            File.WriteAllText(settingsPath, "minMinutes=" + minMinutes + "\r\nmaxMinutes=" + maxMinutes + "\r\norder=" + order + "\r\nonlyMatches=" + (onlyMatches ? 1 : 0) + "\r\n");
        }
        catch { }
    }

    private static Assembly ResolveEmbedded(object sender, ResolveEventArgs args)
    {
        string name = new AssemblyName(args.Name).Name;
        if (name != "Microsoft.Web.WebView2.Core" && name != "Microsoft.Web.WebView2.WinForms") return null;
        using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name + ".dll"))
        {
            if (stream == null) return null;
            using (MemoryStream memory = new MemoryStream()) { stream.CopyTo(memory); return Assembly.Load(memory.ToArray()); }
        }
    }

    // Writes Microsoft's embedded WebView2Loader.dll to a folder named after its hash, so the app stays a single .exe.
    private static void PrepareLoader()
    {
        byte[] loader;
        using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("WebView2Loader.dll"))
        using (MemoryStream memory = new MemoryStream()) { stream.CopyTo(memory); loader = memory.ToArray(); }
        string hash;
        using (SHA256 sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(loader)).Replace("-", "").Substring(0, 16);
        string folder = Path.Combine(DataRoot, "runtime", hash);
        string path = Path.Combine(folder, "WebView2Loader.dll");
        if (File.Exists(path))
        {
            if (!File.ReadAllBytes(path).SequenceEqual(loader)) throw new IOException("The extracted WebView2 loader was modified: " + path);
        }
        else
        {
            Directory.CreateDirectory(folder);
            using (FileStream output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                output.Write(loader, 0, loader.Length);
        }
        CoreWebView2Environment.SetLoaderDllFolderPath(folder);
    }

    // Moves data from the app's earlier name (%LOCALAPPDATA%\DiscordLocalGame) once. If something
    // in the old folder is in use, the history, settings and stats are copied and the rest is left where it is.
    private static void MigrateLegacyData()
    {
        if (Directory.Exists(DataRoot)) return;
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string legacy = new[] { "DiscordLocalGame" }.Select(name => Path.Combine(local, name)).FirstOrDefault(Directory.Exists);
        if (legacy == null) return;
        try { Directory.Move(legacy, DataRoot); }
        catch (Exception)
        {
            try
            {
                Directory.CreateDirectory(DataRoot);
                foreach (string name in new[] { "rotation-history.txt", "settings.txt", "stats.txt" })
                {
                    string source = Path.Combine(legacy, name);
                    if (File.Exists(source)) File.Copy(source, Path.Combine(DataRoot, name));
                }
            }
            catch { }
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Run()
    {
        MigrateLegacyData();
        PrepareLoader();
        Application.Run(new Launcher());
    }

    [STAThread]
    private static void Main()
    {
        try { Native.SetProcessDPIAware(); } catch { }
        AppDomain.CurrentDomain.AssemblyResolve += ResolveEmbedded;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try { Run(); }
        catch (Exception ex) { MessageBox.Show(ex.Message, "Badge Booster", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }
}
