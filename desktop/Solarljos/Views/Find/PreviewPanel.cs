using System.Text.Json;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;

namespace Solarljos.Views.Find;

/// <summary>What the engine says a copy's first bytes are, and how it sends them (GET copy/&lt;uid&gt;/about).</summary>
public sealed record About(long? Size, string? Preview, string? MediaType, string? Ext)
{
    public static About From(JsonElement a)
    {
        static string? S(JsonElement o, string k) => o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        return new About(a.TryGetProperty("size", out var s) && s.ValueKind == JsonValueKind.Number ? (long)s.GetDouble() : null,
            S(a, "preview"), S(a, "mediaType"), S(a, "ext"));
    }
}

/// <summary>
/// One copy, shown the way its bytes allow -- a picture, a video, text, the bytes themselves --
/// with everything known about it (previewPanel in app.js). What the bytes are is asked of the
/// engine (copy/&lt;uid&gt;/about, from their first 4 KB); the first page of them is read at
/// once, for a copy that is nothing but zeros says so before anything else: its data was erased.
/// Its tabs are built the first time each is chosen, then kept as they were left; a video in one
/// that is left is paused.
/// </summary>
public sealed class PreviewPanel : UserControl
{
    static Tr T => Tr.Instance;

    public const int HexPage = 2048;

    readonly Session session;
    readonly Copy copy;
    readonly int firstTab;
    readonly TextBlock heading;
    readonly StackPanel body = new() { Margin = new Thickness(0, 12, 0, 0) };
    TabControl? tabs;
    readonly List<PreviewParts.IPart> parts = new();
    readonly CancellationTokenSource cancel = new();

    public Copy Copy => copy;

    /// <summary>The tab chosen, to open again on; the one asked for until the tabs are there.</summary>
    public int Tab => tabs?.SelectedIndex is >= 0 and var i ? i : firstTab;

    public PreviewPanel(Session session, Copy copy, Action? onClose, int tab, Action<Copy>? restore)
    {
        this.session = session;
        this.copy = copy;
        firstTab = tab;
        var name = copy.Name ?? T["results.nameUnknown"];
        heading = Build.Heading(name, 2);
        heading.Focusable = true;
        heading.FocusVisualStyle = null;
        KeyboardNavigation.SetIsTabStop(heading, false);
        heading.Margin = new Thickness(0, 4, 0, 0);
        var close = onClose is null ? null : PreviewParts.IconButton("close", T["common.close"], onClose);
        var head = Arrangement.HeadRow(heading, close, 12);
        head.Margin = new Thickness(0, 0, 0, 8);

        var badges = new WrapPanel();
        badges.Children.Add(Build.TierBadge(copy).Margin(0, 0, 8, 4));
        badges.Children.Add(Build.StateBadge(copy.State).Margin(0, 0, 8, 4));
        var all = Build.Stack(head, badges);
        if (copy.Tier != "exact") all.Children.Add(Build.Text(Formats.TierHelp(copy), "Hint").Margin(0, 8, 0, 0));
        body.Children.Add(Build.Text(T["preview.loading"], "Muted"));
        all.Children.Add(body);
        if (restore is not null && copy.Tier != "gone")
        {
            var line = new Border { Height = 1, Margin = new Thickness(0, 16, 0, 16) };
            line.SetResourceReference(Border.BackgroundProperty, "Divider");
            all.Children.Add(line);
            var b = Build.Button(T["results.restore"], () => restore(copy));
            b.MinHeight = 32;
            b.Padding = new Thickness(12, 4, 12, 4);
            b.FontSize = 14;
            Look.SetRadius(b, new CornerRadius(8));
            all.Children.Add(b);
        }
        Content = all;
        AutomationProperties.SetName(this, name);
        if (copy.IsDir || copy.Tier == "gone")
        {
            body.Children.Clear();
            body.Children.Add(Say("info", copy.IsDir ? T["preview.folder"] : T["preview.none.gone"]));
            body.Children.Add(PreviewParts.InfoList(copy, null));
            return;
        }
        Loaded += OnFirstLoad;
    }

    async void OnFirstLoad(object? sender, RoutedEventArgs e)
    {
        Loaded -= OnFirstLoad;
        await LoadAsync();
    }

    public void FocusHeading() => heading.Focus();

    /// <summary>For the pictures of the window: the text read in another encoding, its long lines wrapped.</summary>
    internal void Read(string? encoding, bool wrap)
    {
        foreach (var t in parts.OfType<PreviewParts.TextPart>()) t.Set(encoding, wrap);
    }

    /// <summary>Chooses a tab, once there are tabs.</summary>
    public void Choose(int i)
    {
        if (tabs is not null && i >= 0 && i < tabs.Items.Count) tabs.SelectedIndex = i;
    }

    static Border Say(string kind, string text) => Build.Callout(kind, null, Build.Text(text, "Body")).Margin(0, 0, 0, 8);

    async Task LoadAsync()
    {
        About a;
        byte[] head;
        try
        {
            var aboutTask = session.Client.AboutAsync(copy.Uid, cancel.Token);
            var headTask = session.Client.ReadBytesAsync(copy.Uid, 0, HexPage, cancel.Token);
            a = About.From(await aboutTask);
            head = await headTask;
        }
        catch (OperationCanceledException) when (cancel.IsCancellationRequested)
        {
            // Closed meanwhile.
            return;
        }
        catch (Exception e) when (Arrangement.IsTrouble(e))
        {
            body.Children.Clear();
            body.Children.Add(Say("error", e is CoreException { Status: 410 } ? T["empty.noLongerThere"] : Formats.ErrorText(e)));
            body.Children.Add(PreviewParts.InfoList(copy, null));
            return;
        }
        body.Children.Clear();
        bool zero = Bytes.IsAllZero(head);
        if (zero)
        {
            bool whole = a.Size is { } size && size <= head.Length;
            body.Children.Add(Say("error", whole ? T["preview.allZero"] : T.Get("preview.startsZero", ("size", Formats.Size(head.Length)))));
        }
        else if (a.Size == 0 || (head.Length == 0 && a.Size is null))
        {
            body.Children.Add(Say("info", T["preview.empty"]));
        }
        if (!zero && PreviewParts.Mismatch(copy, a) is { } said) body.Children.Add(Say("warn", said));
        var list = new List<(string Label, Func<PreviewParts.IPart> Make)>();
        var window = () => Window.GetWindow(this);
        if (a.Preview == "image") list.Add((T["preview.tab.picture"], () => new PreviewParts.Picture(session, copy, a, window)));
        if (a.Preview == "video") list.Add((T["preview.tab.video"], () => new PreviewParts.Video(session, copy, a)));
        if (a.Preview == "text") list.Add((T["preview.tab.text"], () => new PreviewParts.TextPart(session, copy, a, head, window)));
        if (a.Preview is null && !zero && head.Length > 0)
            body.Children.Add(Say("info", T.Get("preview.none.format", ("format", Formats.FormatName(a.Ext ?? copy.Ext ?? Paths.ExtOf(copy.Name ?? ""))))));
        if (head.Length > 0) list.Add((T["preview.tab.hex"], () => new PreviewParts.Hex(session, copy, a, head)));
        list.Add((T["preview.tab.info"], () => new PreviewParts.Info(copy, a)));
        if (list.Count == 1)
        {
            var only = list[0].Make();
            parts.Add(only);
            body.Children.Add(only.El);
            return;
        }
        tabs = new TabControl();
        tabs.SetResourceReference(StyleProperty, "FindTabs");
        AutomationProperties.SetName(tabs, T["preview.title"]);
        var made = new Dictionary<int, PreviewParts.IPart>();
        foreach (var (label, make) in list)
        {
            var item = new TabItem { Header = label };
            item.SetResourceReference(StyleProperty, "FindTab");
            AutomationProperties.SetName(item, label);
            tabs.Items.Add(item);
        }
        tabs.SelectionChanged += (_, ev) =>
        {
            if (ev.OriginalSource != tabs) return;
            for (int i = 0; i < tabs.Items.Count; i++)
            {
                if (i == tabs.SelectedIndex) continue;
                if (made.TryGetValue(i, out var other)) other.Pause();
            }
            Ensure(tabs.SelectedIndex);
        };
        // Home and End go to the first and the last tab, as the page's tabs do.
        tabs.PreviewKeyDown += (_, ev) =>
        {
            if (ev.OriginalSource is not TabItem || tabs.Items.Count == 0) return;
            int to = ev.Key switch { Key.Home => 0, Key.End => tabs.Items.Count - 1, _ => -1 };
            if (to < 0) return;
            ev.Handled = true;
            tabs.SelectedIndex = to;
            ((TabItem)tabs.Items[to]).Focus();
        };
        void Ensure(int i)
        {
            if (i < 0 || made.ContainsKey(i)) return;
            var part = list[i].Make();
            made[i] = part;
            parts.Add(part);
            ((TabItem)tabs.Items[i]).Content = part.El;
        }
        int first = firstTab >= 0 && firstTab < list.Count ? firstTab : 0;
        Ensure(first);
        tabs.SelectedIndex = first;
        body.Children.Add(tabs);
    }

    /// <summary>Stops what it plays and what it reads: it is closed, or out of sight.</summary>
    public void Pause()
    {
        foreach (var p in parts) p.Pause();
    }

    public void Destroy()
    {
        cancel.Cancel();
        foreach (var p in parts) p.Destroy();
    }
}
