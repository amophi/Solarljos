using System.Text.Json;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;

namespace Solarljos.Views.Shared;

/// <summary>What a folder's plan writes, for the dialog that asks where (a rebuild).</summary>
public sealed record RebuildRequest(Job Plan, string Folder, string FolderName, IReadOnlyList<long?> Sizes, int Count,
    IReadOnlyList<string> Exclude, IReadOnlyList<string> Include, int LeftOutIn);

/// <summary>
/// Where to put copies back, checked before anything is written (openRestoreDialog in app.js). A
/// folder a source reads from is refused by the engine, and said so here; the drive a lost file
/// was on needs the person's word, since writing there can overwrite what is still to be found.
/// A folder on another drive is suggested when there is one. For a folder's plan, the same, and
/// then the rebuild starts. The folder is typed or pasted, or put in from a drive's button: no
/// folder picker, since Windows' own shows the folders' pictures and writes them into the very
/// thumbnail cache a search for photos reads.
/// </summary>
public sealed class RestoreDialog : Window
{
    static Tr T => Tr.Instance;

    readonly Session session;
    readonly List<Copy> copies;
    readonly RebuildRequest? rebuild;
    readonly List<string> originals;
    readonly long needed;
    readonly bool unknownSizes;
    readonly TextBox input = Build.PathBox();
    readonly Build.Field dest;
    readonly WrapPanel drivesEl = new() { Margin = new Thickness(0, 0, 0, 8) };
    readonly StackPanel suggestLine = new();
    readonly StackPanel checks = new();
    readonly CheckBox confirm;
    readonly TextBlock progress = Build.Text("", "Muted");
    readonly Button submit;
    readonly Button cancel;
    readonly string submitLabel;
    readonly DispatcherTimer debounce = new() { Interval = TimeSpan.FromMilliseconds(350) };
    readonly StackPanel body;
    readonly StackPanel buttons;
    Check? check;
    int checkSeq;
    bool writing;
    List<JsonElement> drives = new();
    (string Path, string Reason, string? Root)? suggestion;

    /// <summary>A rebuild started from here, for the view that shows it.</summary>
    public Job? Started { get; private set; }

    sealed class Check
    {
        public bool Ok;
        public string? Error;
        public string Path = "";
        public bool Exists;
        public long? Free;
        public string? Root;
        public int? Same;
        public int Device;
        public bool Full;
    }

    public RestoreDialog(Window owner, Session session, IEnumerable<Copy>? copies = null, RebuildRequest? rebuild = null)
    {
        this.session = session;
        this.copies = (copies ?? []).ToList();
        this.rebuild = rebuild;
        Owner = owner;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        SizeToContent = SizeToContent.Height;
        Width = 640;
        ShowInTaskbar = false;
        FlowDirection = owner.FlowDirection;
        SetResourceReference(BackgroundProperty, "Card");
        SetResourceReference(ForegroundProperty, "Text");
        SetResourceReference(FontFamilyProperty, "UiFont");
        FontSize = 15;
        SourceInitialized += (_, _) => Theme.TitleBar(this, round: true);

        string title;
        if (rebuild is not null) title = T.Get("rebuild.dialogTitle", ("folder", rebuild.FolderName));
        else if (this.copies.Count == 1) title = T.Get("restore.title.one", ("name", this.copies[0].Name ?? T["results.nameUnknown"]));
        else title = T.Get("restore.title.many", ("count", this.copies.Count));
        Title = title;
        originals = rebuild is not null ? [rebuild.Folder] : this.copies.Select((c) => c.Path).OfType<string>().ToList();
        var sizes = rebuild is not null ? rebuild.Sizes : this.copies.Select((c) => c.IsDir ? null : c.Size).ToList();
        needed = sizes.Sum((s) => s ?? 0);
        unknownSizes = sizes.Any((s) => s is null);

        dest = Build.LabeledField(T["restore.dest.label"], input, PathHint("restore.dest.hint"));
        dest.El.Margin = new Thickness(0, 16, 0, 8);
        confirm = Build.Check(T["dest.sameDrive.confirm"], false);
        confirm.Visibility = Visibility.Collapsed;
        confirm.Margin = new Thickness(0, 8, 0, 0);
        confirm.Checked += (_, _) => Gate();
        confirm.Unchecked += (_, _) => Gate();
        progress.Visibility = Visibility.Collapsed;
        AutomationProperties.SetLiveSetting(progress, AutomationLiveSetting.Polite);

        submitLabel = rebuild is not null ? T.Get("rebuild.submit", ("count", rebuild.Count))
            : this.copies.Count == 1 ? T["restore.submit"] : T.Get("restore.submitMany", ("count", this.copies.Count));
        submit = Build.Button(submitLabel, async () => await SubmitAsync(), "BtnPrimary");
        submit.IsEnabled = false;
        submit.IsDefault = true;
        cancel = Build.Button(T["common.cancel"], () => Close());
        cancel.IsCancel = true;
        foreach (var b in new[] { cancel, submit })
        {
            b.MinHeight = 48;
            b.FontSize = 16;
            Look.SetRadius(b, new CornerRadius(14));
        }
        cancel.Margin = new Thickness(0, 0, 8, 0);
        buttons = Build.Stack(Orientation.Horizontal, cancel, submit);
        buttons.HorizontalAlignment = HorizontalAlignment.Right;
        buttons.Margin = new Thickness(0, 24, 0, 0);

        body = Build.Stack(Build.Heading(title, 2), dest.El, Labeled.Group(T["restore.drives"], drivesEl), suggestLine, checks, confirm, TierLines(), progress.Margin(0, 8, 0, 0));
        var all = Build.Stack(body, buttons);
        all.Margin = new Thickness(28, 24, 28, 24);
        Content = new ScrollViewer { Content = all, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, MaxHeight = 760 };

        input.TextChanged += (_, _) => ScheduleCheck(350);
        debounce.Tick += async (_, _) =>
        {
            debounce.Stop();
            await RunCheckAsync();
        };
        Closing += (_, e) =>
        {
            // Not while files are being written: they finish first.
            if (writing) e.Cancel = true;
        };
        Closed += (_, _) =>
        {
            debounce.Stop();
            session.Jobs.RestoreProgress -= OnRestoreProgress;
        };
        Loaded += async (_, _) =>
        {
            Keyboard.Focus(input);
            await SuggestAsync();
        };
    }

    /// <summary>A path field's hint, with how to copy a folder's path in Explorer.</summary>
    static string PathHint(string key) => T[key] + " " + T["common.pathTip"];

    // ---- where to suggest ---------------------------------------------------------------------

    static string? S(JsonElement o, string k) => o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    static bool B(JsonElement o, string k) => o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.True;
    static long? L(JsonElement o, string k) => o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? (long)v.GetDouble() : null;

    string FolderOn(string root) => Paths.Join(root, T.Plain("restore.folderName"), Formats.Stamp(DateTimeOffset.Now));

    /// <summary>
    /// A folder to restore into, before anything is typed: on a drive none of the copies came from
    /// (suggestDestination in app.js). The drive this program runs from, when it is not the
    /// system's; another drive that answers, is not a network one and has the room; else a new
    /// folder on the Desktop or in the home folder. A memory card being recovered is never suggested.
    /// </summary>
    (string Path, string Reason, string? Root) Suggest(bool desktop)
    {
        var info = session.Info;
        var avoid = session.Added.TryGetValue("removable", out var r) ? r : [];
        var devices = avoid.Where(Paths.IsDevice).ToList();
        var held = originals.Select(Paths.RootOf).Concat(avoid.Where((p) => !Paths.IsDevice(p)).Select(Paths.RootOf)).OfType<string>().ToList();
        var system = Paths.RootOf(S(info, "systemDrive"));
        bool usable(JsonElement d) => devices.Count == 0 && !(d.TryGetProperty("answering", out var a) && a.ValueKind == JsonValueKind.False)
            && S(d, "error") is null && !held.Any((h) => Paths.SameRoot(h, S(d, "root")))
            && (L(d, "free") is not { } free || needed == 0 || free > needed);
        var runsFrom = System.IO.Path.GetPathRoot(AppContext.BaseDirectory);
        var mine = drives.FirstOrDefault((x) => Paths.SameRoot(S(x, "root"), runsFrom));
        if (mine.ValueKind == JsonValueKind.Object && usable(mine) && !Paths.SameRoot(S(mine, "root"), system) && !B(mine, "network"))
            return (FolderOn(S(mine, "root")!), "exeDrive", S(mine, "root"));
        var others = drives.Where((d) => usable(d) && !B(d, "network") && !B(d, "system") && !Paths.SameRoot(S(d, "root"), system) && S(d, "root") != "/")
            .OrderByDescending((d) => L(d, "free") ?? 0).ToList();
        if (others.Count > 0) return (FolderOn(S(others[0], "root")!), "otherDrive", S(others[0], "root"));
        var home = S(info, "home") ?? "";
        if (home.Length == 0) return ("", "home", null);
        return desktop ? (FolderOn(Paths.Join(home, "Desktop")), "desktop", Paths.RootOf(home)) : (FolderOn(home), "home", Paths.RootOf(home));
    }

    async Task SuggestAsync()
    {
        try
        {
            var d = await session.Client.GetAsync("/api/drives");
            drives = d.TryGetProperty("drives", out var list) ? list.EnumerateArray().ToList() : [];
        }
        catch (Exception e) when (e is CoreException or HttpRequestException)
        {
            drives = [];
        }
        suggestion = Suggest(false);
        if (suggestion.Value.Reason == "home" && S(session.Info, "home") is { } home)
        {
            try
            {
                var c = await session.Client.PostAsync("/api/check-folder", new { to = Paths.Join(home, "Desktop") });
                if (B(c, "ok") && B(c, "exists")) suggestion = Suggest(true);
            }
            catch (Exception e) when (e is CoreException or HttpRequestException)
            {
            }
        }
        if (!IsLoaded) return;
        RenderDrives();
        if (suggestion.Value.Path.Length > 0)
        {
            suggestLine.Children.Add(Build.Text(T.Get("restore.suggest." + suggestion.Value.Reason, ("drive", suggestion.Value.Root ?? "")), "Hint"));
            if (input.Text.Trim().Length == 0)
            {
                input.Text = suggestion.Value.Path;
                input.SelectAll();
            }
        }
        ScheduleCheck(0);
    }

    void RenderDrives()
    {
        drivesEl.Children.Clear();
        var usable = drives.Where((d) => S(d, "root") is not null && !(d.TryGetProperty("answering", out var a) && a.ValueKind == JsonValueKind.False) && S(d, "error") is null).ToList();
        if (usable.Count < 2) return;
        drivesEl.Children.Add(Build.Text(T["restore.drives"] + ":", "Muted").Margin(0, 6, 8, 0));
        foreach (var d in usable)
        {
            var root = S(d, "root")!;
            var marks = new List<string>();
            if (B(d, "system")) marks.Add(T["restore.drive.system"]);
            if (originals.Any((p) => Paths.SameRoot(Paths.RootOf(p), root))) marks.Add(T["restore.drive.original"]);
            var letter = S(d, "letter") is { } l ? l + ":" : root;
            var text = letter + (L(d, "free") is { } free ? " " + T.Get("restore.driveFree", ("free", Formats.Size(free))) : "")
                + (marks.Count > 0 ? $" ({string.Join(", ", marks)})" : "");
            var b = Build.Button(text, () =>
            {
                input.Text = FolderOn(root);
                ScheduleCheck(0);
                input.Focus();
            });
            b.MinHeight = 32;
            b.Padding = new Thickness(12, 4, 12, 4);
            b.FontSize = 14;
            b.Margin = new Thickness(0, 0, 8, 8);
            Look.SetRadius(b, new CornerRadius(8));
            drivesEl.Children.Add(b);
        }
    }

    // ---- checking the folder -----------------------------------------------------------------

    /// <summary>Every change of folder is checked anew, and a word given for one folder is not taken for another.</summary>
    void ScheduleCheck(int ms)
    {
        debounce.Stop();
        check = null;
        confirm.IsChecked = false;
        Gate();
        if (ms == 0)
        {
            _ = RunCheckAsync();
            return;
        }
        debounce.Interval = TimeSpan.FromMilliseconds(ms);
        debounce.Start();
    }

    void Gate()
    {
        bool same = check is { Ok: true } && (check.Same > 0 || check.Device > 0);
        confirm.Visibility = same ? Visibility.Visible : Visibility.Collapsed;
        bool blocked = check is null || !check.Ok || check.Full || (same && confirm.IsChecked != true);
        submit.IsEnabled = !writing && input.Text.Trim().Length > 0 && !blocked;
    }

    async Task RunCheckAsync()
    {
        var to = input.Text.Trim();
        int seq = ++checkSeq;
        checks.Children.Clear();
        // Said once, not again at every pause in the typing of a path not yet whole.
        var wrong = to.Length > 0 && !Paths.IsAbsolute(Paths.Unquote(to)) ? T["dest.relative"] : null;
        if (wrong != fieldError)
        {
            fieldError = wrong;
            dest.SetError(wrong);
        }
        if (to.Length == 0 || wrong is not null)
        {
            Gate();
            return;
        }
        checks.Children.Add(Build.Text(T["dest.checking"], "Muted"));
        JsonElement c;
        try
        {
            c = rebuild is not null
                ? await session.Client.PostAsync("/api/check-folder", new { to, plan = rebuild.Plan.Id })
                : await session.Client.PostAsync("/api/check-folder", new { to, uids = copies.Select((x) => x.Uid).ToArray() });
        }
        catch (Exception e)
        {
            if (seq != checkSeq) return;
            checks.Children.Clear();
            checks.Children.Add(Build.Callout("error", null, Build.Text(Formats.ErrorText(e), "Body")));
            check = new Check { Ok = false };
            Gate();
            Announce.Alert(Formats.ErrorText(e));
            return;
        }
        if (seq != checkSeq) return;
        var k = new Check
        {
            Ok = B(c, "ok"), Error = S(c, "error"), Path = S(c, "path") ?? to, Exists = B(c, "exists"), Free = L(c, "free"), Root = S(c, "root"),
        };
        if (k.Ok) k.Same = SameCount(c, k);
        // Items read from a whole disk, whose letter cannot be told: any drive but Windows' and the network's may be it.
        bool shared = (k.Root ?? "").StartsWith(@"\\", StringComparison.Ordinal) || drives.Any((x) => Paths.SameRoot(S(x, "root"), k.Root) && B(x, "network"));
        long onDevice = L(c, "onDevice") ?? 0;
        k.Device = k.Ok && !shared && onDevice > 0 && !Paths.SameRoot(k.Root, Paths.RootOf(S(session.Info, "systemDrive"))) ? (int)onDevice : 0;
        k.Full = k.Ok && k.Free is { } free && needed > free;
        check = k;
        Render(k);
        Gate();
        SayChecks(!k.Ok || k.Full);
    }

    string? fieldError;

    /// <summary>
    /// What the check found, said as the page's status region says it: why Restore stays off, the
    /// box that asks for the person's word appearing. At once when the folder cannot be used.
    /// </summary>
    void SayChecks(bool urgent)
    {
        var said = string.Join(" ", Texts(checks).Where((t) => t.Length > 0));
        if (urgent) Announce.Alert(said);
        else Announce.Say(said);
    }

    static IEnumerable<string> Texts(DependencyObject root)
    {
        foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>())
        {
            if (child is TextBlock { Visibility: Visibility.Visible } tb) yield return tb.Text;
            else if (child is not Button) foreach (var t in Texts(child)) yield return t;
        }
    }

    /// <summary>How many of the items were on the drive of the folder checked: the engine's count, else by drive letter; null where neither can tell.</summary>
    int? SameCount(JsonElement c, Check k)
    {
        if (c.TryGetProperty("sameDrive", out var sd) && sd.ValueKind == JsonValueKind.Number) return sd.GetInt32();
        if (k.Root is null || k.Root == "/") return null;
        if (rebuild is not null) return Paths.SameRoot(Paths.RootOf(rebuild.Folder), k.Root) ? rebuild.Count : 0;
        return originals.Count((p) => Paths.SameRoot(Paths.RootOf(p), k.Root));
    }

    void Render(Check c)
    {
        checks.Children.Clear();
        if (!c.Ok)
        {
            checks.Children.Add(Build.Callout("error", T["dest.refused.title"], Build.Text(c.Error ?? "", "Body")));
            return;
        }
        if (c.Same > 0)
        {
            var other = suggestion is { Path.Length: > 0, Root: { } r } s && !Paths.SameRoot(r, c.Root) ? s : ((string, string, string?)?)null;
            Button? use = null;
            if (other is { } o)
            {
                use = Build.Button(T.Get("restore.useSuggested", ("path", o.Item1)), () =>
                {
                    input.Text = o.Item1;
                    ScheduleCheck(0);
                });
                use.Margin = new Thickness(0, 8, 0, 0);
            }
            checks.Children.Add(Build.Callout("warn", T.Get("dest.sameDrive.title", ("drive", c.Root ?? "")),
                Build.Text(T["dest.sameDrive.body"], "Body"),
                copies.Count > 1 || rebuild is not null ? Build.Text(T.Get("dest.sameDrive.many", ("count", c.Same ?? 0)), "Body") : null,
                use));
        }
        else if (c.Device > 0)
        {
            checks.Children.Add(Build.Callout("warn", T["dest.onDevice.title"], Build.Text(T.Get("dest.onDevice.body", ("count", c.Device)), "Body")));
        }
        else if (c.Same is null)
        {
            checks.Children.Add(Build.Callout("info", null, Build.Text(T["dest.sameDrive.unknown"], "Body")));
        }
        else if (Paths.SameRoot(c.Root, Paths.RootOf(S(session.Info, "systemDrive"))))
        {
            checks.Children.Add(Build.Callout("info", null, Build.Text(T["dest.systemDrive"], "Body")));
        }
        bool network = drives.Any((x) => Paths.SameRoot(S(x, "root"), c.Root) && B(x, "network")) || (c.Root ?? "").StartsWith(@"\\", StringComparison.Ordinal);
        if (network) checks.Children.Add(Build.Callout("info", null, Build.Text(T["dest.network"], "Body")));
        if (Paths.SyncedBy(c.Path) is { } service) checks.Children.Add(Build.Callout("info", null, Build.Text(T.Get("dest.cloud", ("service", service)), "Body")));
        var space = new[] { ("needed", (object?)Formats.Size(needed)), ("free", Formats.Size(c.Free)) };
        if (c.Full) checks.Children.Add(Build.Callout("error", null, Build.Text(T.Get("dest.noSpace", space), "Body")));
        else if (c.Free is not null && needed > 0) checks.Children.Add(Build.Text(T.Get(unknownSizes ? "dest.spaceAtLeast" : "dest.space", space), "Muted"));
        if (!c.Exists) checks.Children.Add(Build.Text(T["dest.newFolder"], "Muted"));
        if (rebuild is null && copies.Count == 1 && copies[0].Tier is "exact" or "inexact" or "draft")
            checks.Children.Add(Build.Text(T.Get("restore.name", ("name", PlainName(copies[0]))), "Body"));
    }

    /// <summary>The name the library gives a copy it writes, where that is simply its own (restore.js nameFor()).</summary>
    static string PlainName(Copy c) => c.Name ?? $"recovered-{c.Uid[..Math.Min(8, c.Uid.Length)]}{c.Ext}";

    /// <summary>What each kind of copy becomes when written, said before it is.</summary>
    StackPanel TierLines()
    {
        var s = new StackPanel { Margin = new Thickness(0, 8, 0, 0) };
        void add(string text) => s.Children.Add(Build.Text(text, "Hint"));
        if (rebuild is not null)
        {
            if (rebuild.LeftOutIn > 0) add(T.Get("restore.many.leftOut", ("count", rebuild.LeftOutIn)));
            return s;
        }
        if (copies.Count == 1)
        {
            var c = copies[0];
            switch (c.Tier)
            {
                case "derived":
                    add(c.Width is { } w && c.Height is { } h ? T.Get("restore.nameSmaller", ("size", $"{w}x{h}")) : T["restore.nameSmallerNoSize"]);
                    break;
                case "draft": add(T["restore.nameDraft"]); break;
                case "inexact": add(T[c.FromDisk ? "restore.nameNearDisk" : "restore.nameNear"]); break;
                case "unverified": add(T["restore.nameIncomplete"]); break;
                case "folder": add(T.Get("restore.folder", ("name", c.Name ?? T["results.nameUnknown"]))); break;
            }
            return s;
        }
        int n(string t) => copies.Count((c) => c.Tier == t);
        if (n("derived") > 0) add(T.Get("restore.many.derived", ("count", n("derived"))));
        if (n("unverified") > 0) add(T.Get("restore.many.unverified", ("count", n("unverified"))));
        if (n("draft") > 0) add(T.Get("restore.many.draft", ("count", n("draft"))));
        return s;
    }

    // ---- writing -------------------------------------------------------------------------------

    void OnRestoreProgress(JsonElement d)
    {
        long done = L(d, "done") ?? 0, total = L(d, "total") ?? copies.Count;
        progress.Text = T.Get("restore.progress", ("done", done), ("total", total));
        if (AutomationPeer.ListenerExists(AutomationEvents.LiveRegionChanged))
            (UIElementAutomationPeer.FromElement(progress) ?? UIElementAutomationPeer.CreatePeerForElement(progress))?.RaiseAutomationEvent(AutomationEvents.LiveRegionChanged);
    }

    async Task SubmitAsync()
    {
        if (!submit.IsEnabled) return;
        writing = true;
        Gate();
        submit.Content = T["restore.working"];
        cancel.IsEnabled = false;
        var to = input.Text.Trim();
        try
        {
            if (rebuild is not null)
            {
                Started = await session.Jobs.RebuildAsync(new { plan = rebuild.Plan.Id, to, exclude = rebuild.Exclude, include = rebuild.Include });
                writing = false;
                Close();
                return;
            }
            if (copies.Count > 1)
            {
                progress.Visibility = Visibility.Visible;
                session.Jobs.RestoreProgress += OnRestoreProgress;
            }
            var res = await session.Client.PostAsync("/api/restore", new { uids = copies.Select((c) => c.Uid).ToArray(), to });
            ShowDone(res, to);
        }
        catch (Exception e)
        {
            // Whatever went wrong, the dialog is not left locked; what was written stays.
            writing = false;
            submit.Content = submitLabel;
            cancel.IsEnabled = true;
            checks.Children.Insert(0, Build.Callout("error", T["error.title"], Build.Text(Formats.ErrorText(e), "Body")));
            Announce.Alert(Formats.ErrorText(e));
            Gate();
        }
        finally
        {
            session.Jobs.RestoreProgress -= OnRestoreProgress;
        }
    }

    void ShowDone(JsonElement res, string to)
    {
        writing = false;
        var results = res.TryGetProperty("results", out var r) ? r.EnumerateArray().ToList() : [];
        var ok = results.Where((x) => B(x, "ok")).ToList();
        var bad = results.Where((x) => !B(x, "ok")).ToList();
        var byUid = copies.ToDictionary((c) => c.Uid);
        var where = ok.Count == 1 ? S(ok[0], "path") ?? to : S(res, "to") ?? to;
        var heading = ok.Count == 0 ? T["restore.done.none"] : ok.Count == 1 ? T["restore.done.one"] : T.Get("restore.done.many", ("count", ok.Count));
        var icon = new Ui.Icon { Glyph = ok.Count > 0 ? "success" : "error", Width = 28, Height = 28, Margin = new Thickness(0, 0, 12, 0) };
        icon.SetResourceReference(Ui.Icon.ForegroundProperty, ok.Count > 0 ? "Success" : "DangerText");
        var head = Build.Stack(Orientation.Horizontal, icon, Build.Heading(heading, 2));
        var done = Build.Button(T["common.done"], () => Close(), "BtnPrimary");
        // Esc closes it once the writing has ended, as the page's dialog does.
        done.IsCancel = true;
        done.MinHeight = 48;
        Look.SetRadius(done, new CornerRadius(14));
        body.Children.Clear();
        body.Children.Add(head);
        if (ok.Count > 0)
        {
            var path = Build.PathBox(where);
            path.IsReadOnly = true;
            path.Margin = new Thickness(0, 16, 0, 8);
            AutomationProperties.SetName(path, heading);
            body.Children.Add(path);
            var copy = Build.Button(T["common.copyPath"], () => { }, "Btn");
            copy.Click += (_, _) =>
            {
                try
                {
                    Clipboard.SetText(where);
                    copy.Content = T["common.copied"];
                    Announce.Say(T["common.copied"]);
                }
                catch (System.Runtime.InteropServices.ExternalException)
                {
                    Announce.Alert(T["common.copyFailed"]);
                }
            };
            body.Children.Add(copy);
        }
        if (bad.Count > 0)
        {
            var lines = bad.Select((b) =>
            {
                var name = byUid.TryGetValue(S(b, "uid") ?? "", out var c) ? c.Name ?? c.Uid : S(b, "uid") ?? "";
                var why = Formats.ErrorText(new CoreException(0, S(b, "error") ?? "", S(b, "code"), default));
                // The name in its own direction, as the page's <bdi>.
                return (UIElement)Build.Text($"• \u2068{name}\u2069: {why}", "Body");
            }).ToArray();
            body.Children.Add(Build.Callout("warn", T.Get("restore.done.failed", ("count", bad.Count)), lines));
        }
        if (ok.Count > 0) body.Children.Add(Build.Text(T["restore.openWarning"], "Hint").Margin(0, 12, 0, 0));
        buttons.Children.Clear();
        buttons.Children.Add(done);
        Title = heading;
        done.Focus();
        Announce.Say(heading);
    }
}
