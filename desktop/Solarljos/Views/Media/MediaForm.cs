using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;
using Solarljos.Views.Shared;

namespace Solarljos.Views.Media;

/// <summary>
/// Find photos and videos (viewMediaForm in src/gui/ui/app.js): what to look for, from when,
/// where they were, the smaller copies and the pictures of web pages, and under More options the
/// places to search; above it what to expect of an SSD and of a memory card. `last` is what it
/// held, when it is made again in another language (`saved`, More options open or closed as it
/// was), or what was searched for, when a search is made again from its results.
/// </summary>
public sealed class MediaForm
{
    static Tr T => Tr.Instance;

    readonly MediaView owner;
    readonly Session session;
    public FrameworkElement El { get; }
    public TextBlock Title { get; }
    readonly Button back;
    readonly CheckBox photos;
    readonly CheckBox videos;
    readonly TextBlock whatErr;
    readonly Build.Chips when;
    readonly DatePicker fromBox;
    readonly DatePicker toBox;
    readonly Build.Field from;
    readonly Build.Field to;
    readonly WrapPanel range;
    readonly TextBox whereBox;
    readonly Build.Field where;
    readonly Build.SwitchRow smaller;
    readonly Build.SwitchRow web;
    readonly bool hasWeb;
    readonly PlacesField places;
    readonly OtherDiskField disk;
    readonly Expander more;
    readonly Border errorBox = new() { Visibility = Visibility.Collapsed, Focusable = true, FocusVisualStyle = null };
    readonly Button submit;
    bool fromBad;
    bool toBad;

    public MediaForm(MediaView owner, Session session, MediaRequest? last, ResourceDictionary look, bool saved = false)
    {
        this.owner = owner;
        this.session = session;
        var l = last ?? new MediaRequest();

        // ---- what, and when ----
        photos = Build.Check(T["media.what.photos"], l.Types.Contains("image"));
        videos = Build.Check(T["media.what.videos"], l.Types.Contains("video"));
        photos.Margin = new Thickness(0, 0, 24, 8);
        videos.Margin = new Thickness(0, 0, 24, 8);
        var whatTitle = Legend(T["media.what.label"]);
        var checks = new WrapPanel();
        checks.Children.Add(photos);
        checks.Children.Add(videos);
        AutomationProperties.SetName(checks, T["media.what.label"]);
        whatErr = ErrorLine();
        var what = Build.Stack(whatTitle, checks, whatErr);

        when = Build.ChipGroup(T["media.when.label"], [
            ("any", T["media.when.any"]), ("thisYear", T["media.when.thisYear"]), ("lastYear", T["media.when.lastYear"]),
            ("pick", T["media.when.pick"]),
        ], l.WhenChoice, T["media.when.hint"]);
        fromBox = DateBox(l.FromDate, look, (bad) => fromBad = bad);
        toBox = DateBox(l.ToDate, look, (bad) => toBad = bad);
        fromBad = l.FromBad;
        toBad = l.ToBad;
        from = Build.LabeledField(T["media.when.from"], fromBox);
        to = Build.LabeledField(T["media.when.to"], toBox);
        from.El.Margin = new Thickness(0, 0, 24, 8);
        to.El.Margin = new Thickness(0, 0, 0, 8);
        range = new WrapPanel { Margin = new Thickness(0, 16, 0, 0) };
        range.Children.Add(from.El);
        range.Children.Add(to.El);
        when.Changed += SyncWhen;
        SyncWhen();

        // ---- where, and which copies ----
        whereBox = Build.PathBox(l.Where);
        where = Build.LabeledField(T["media.where.label"], whereBox, T["media.where.hint"] + " " + T["common.pathTip"], optional: true);
        smaller = Build.Switch(T["media.smaller.label"], l.IncludeSmaller, T["media.smaller.hint"]);
        hasWeb = session.Sources.Any((s) => s.Id == "browser-cache");
        web = Build.Switch(T["media.web.label"], l.IncludeWeb, T["media.web.hint"]);
        places = new PlacesField("media", l.Sources);
        disk = new OtherDiskField();
        more = Build.More(T["common.advanced"], saved ? l.More : l.Sources is not null, false, places.El, disk.El);

        submit = Build.Button(T["media.submit"], async () => await SubmitAsync(), "BtnLarge");
        submit.Margin = new Thickness(0, 32, 0, 0);

        var pair1 = Build.Pair(what, Build.Stack(when.El, range));
        var pair2 = Build.Pair(smaller.El, hasWeb ? web.El : null);
        var card = Build.Card(Build.Stack(errorBox, pair1, where.El, pair2, more, submit), 32);
        // Enter in a box to type in searches, as a form does.
        card.KeyDown += async (_, e) =>
        {
            if (e.Key != Key.Enter || e.OriginalSource is not TextBox || e.OriginalSource is System.Windows.Controls.Primitives.DatePickerTextBox) return;
            e.Handled = true;
            await SubmitAsync();
        };

        // ---- the heading, and what to expect ----
        Title = Build.Heading(T["media.title"]);
        MediaView.FocusableHeading(Title);
        back = BackLink();
        var head = new DockPanel { Margin = new Thickness(0, 8, 0, 24), LastChildFill = true };
        DockPanel.SetDock(back, Dock.Right);
        head.Children.Add(back);
        head.Children.Add(Title);
        var expect = Build.Callout("info", null, Build.Text(T["media.expect"]), Build.Text(T["media.video"]).Margin(0, 8, 0, 0));
        expect.Margin = new Thickness(0, 0, 0, 8);
        var cardNote = Build.Callout(session.Elevated ? "info" : "plain", T["media.card.title"],
            Build.Text(session.Elevated ? T["media.card.admin"] : T["media.card.body"]));
        cardNote.Margin = new Thickness(0, 0, 0, 16);
        var frozen = Frozen() ? Build.Text(T["media.frozen"], "Hint").Margin(0, 0, 0, 16) : null;
        if (frozen is not null)
        {
            frozen.MaxWidth = 736;
            frozen.HorizontalAlignment = HorizontalAlignment.Left;
        }

        El = Build.Page(Build.Stack(head, expect, cardNote, frozen, card));
        Update();
    }

    static TextBlock Legend(string text)
    {
        var t = Build.Text(text);
        t.FontSize = 16;
        t.FontWeight = FontWeights.Bold;
        t.Margin = new Thickness(0, 0, 0, 12);
        return t;
    }

    static TextBlock ErrorLine()
    {
        var e = new TextBlock { FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 0), Visibility = Visibility.Collapsed };
        e.SetResourceReference(TextBlock.ForegroundProperty, "DangerText");
        return e;
    }

    /// <summary>
    /// A box for a day, typed or chosen on its calendar, in the language's own way of writing a
    /// date. `bad` is told whether what was typed is a day at all; a day that is not there, such as
    /// 30 February, is said to be so when the form is sent.
    /// </summary>
    static DatePicker DateBox(string ymd, ResourceDictionary look, Action<bool> bad)
    {
        var d = new DatePicker { Style = (Style)look["MediaDatePicker"], Language = XmlLanguage.GetLanguage(Tr.Instance.Culture.Name) };
        if (MediaRequest.DayStart(ymd) is not null && DateTime.TryParseExact(ymd, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.None, out var day))
        {
            d.SelectedDate = day;
        }
        d.DateValidationError += (_, e) =>
        {
            e.ThrowException = false;
            bad(true);
        };
        d.SelectedDateChanged += (_, _) => bad(false);
        d.Loaded += (_, _) =>
        {
            // The calendar's button says what it is in the language chosen, not WPF's own English.
            if (d.Template?.FindName("PART_Button", d) is Button b)
            {
                AutomationProperties.SetName(b, Tr.Instance["desktop.media.calendar"]);
                b.ToolTip = Tr.Instance["desktop.media.calendar"];
            }
            if (d.Template?.FindName("PART_TextBox", d) is TextBox tb)
            {
                AutomationProperties.SetName(tb, AutomationProperties.GetName(d));
                tb.TextChanged += (_, _) =>
                {
                    if (tb.Text.Trim().Length == 0) bad(false);
                };
            }
        };
        return d;
    }

    void SyncWhen() => range.Visibility = when.Value == "pick" ? Visibility.Visible : Visibility.Collapsed;

    bool Frozen()
    {
        var info = session.Info;
        if (info.ValueKind != System.Text.Json.JsonValueKind.Object || !info.TryGetProperty("frozen", out var f)
            || f.ValueKind != System.Text.Json.JsonValueKind.Object || !f.TryGetProperty("sources", out var list)
            || list.ValueKind != System.Text.Json.JsonValueKind.Array) return false;
        return list.EnumerateArray().Any((s) => s.TryGetProperty("id", out var id) && id.GetString() == "thumbcache"
            && !(s.TryGetProperty("error", out var e) && e.ValueKind == System.Text.Json.JsonValueKind.String && e.GetString() != ""));
    }

    /// <summary>The way back to the results this form led to, while they are kept: the page's back link, its arrow after its words.</summary>
    static Button BackLink()
    {
        var b = new Button();
        b.SetResourceReference(FrameworkElement.StyleProperty, "Btn");
        b.Padding = new Thickness(16, 8, 10, 8);
        b.VerticalAlignment = VerticalAlignment.Top;
        b.Margin = new Thickness(16, 2, 0, 0);
        b.Click += (_, _) => MainWindow.Navigate("media/results");
        return b;
    }

    /// <summary>Says again what is kept: the way back to the results, and the places added under What is searched.</summary>
    public void Update()
    {
        var job = session.Jobs.Current("media");
        back.Visibility = job is null ? Visibility.Collapsed : Visibility.Visible;
        if (job is not null)
        {
            var text = T[job.Running ? "form.toSearch" : "form.toResults"];
            var icon = new Icon { Glyph = "chevron", Width = 16, Height = 16, Margin = new Thickness(4, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            back.Content = Build.Stack(Orientation.Horizontal, new TextBlock { Text = text, VerticalAlignment = VerticalAlignment.Center }, icon);
            AutomationProperties.SetName(back, text);
        }
        disk.Update();
    }

    /// <summary>What the form holds; `raw`, as typed, spaces and all.</summary>
    MediaRequest Values(bool raw)
    {
        var w = raw ? whereBox.Text : Paths.Unquote(whereBox.Text);
        return new MediaRequest
        {
            Types = new[] { photos.IsChecked == true ? "image" : null, videos.IsChecked == true ? "video" : null }.OfType<string>().ToList(),
            WhenChoice = when.Value,
            FromDate = Ymd(fromBox),
            ToDate = Ymd(toBox),
            Where = w,
            IncludeSmaller = smaller.IsOn,
            IncludeWeb = hasWeb && web.IsOn,
            Sources = places.Value(),
        };
    }

    static string Ymd(DatePicker d) => d.SelectedDate is { } day ? day.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture) : "";

    /// <summary>The form as it is now, for one made again in another language.</summary>
    public MediaRequest Save()
    {
        var r = Values(true);
        r.More = more.IsExpanded;
        r.FromBad = fromBad;
        r.ToBad = toBad;
        return r;
    }

    // ---- sending it ----------------------------------------------------------------------------

    async Task SubmitAsync()
    {
        if (!submit.IsEnabled) return;
        whatErr.Visibility = Visibility.Collapsed;
        from.SetError(null);
        where.SetError(null);
        ClearError();
        var request = Values(false);
        IInputElement? bad = null;
        if (request.Types.Count == 0)
        {
            whatErr.Text = "! " + T["media.what.missing"];
            whatErr.Visibility = Visibility.Visible;
            AutomationProperties.SetHelpText(photos, T["media.what.missing"]);
            Announce.Alert(T["media.what.missing"]);
            bad = photos;
        }
        else
        {
            AutomationProperties.SetHelpText(photos, "");
        }
        var picked = request.WhenChoice == "pick";
        var dates = picked && (fromBad || toBad) ? null : MediaRequest.Range(request.WhenChoice, request.FromDate, request.ToDate);
        if (dates is null)
        {
            if (fromBad || toBad) from.SetError(T["media.when.bad"]);
            else if (request.FromDate.Length == 0 && request.ToDate.Length == 0) from.SetError(T["media.when.missing"]);
            else from.SetError(T["media.when.badRange"]);
            bad ??= fromBox;
        }
        if (request.Where.Length > 0 && !Paths.IsAbsolute(request.Where))
        {
            where.SetError(T["folder.path.relative"]);
            bad ??= whereBox;
        }
        if (bad is null && places.Validate() is { } none)
        {
            // The boxes are under More options, which may have been closed since.
            more.IsExpanded = true;
            bad = none;
        }
        if (bad is not null)
        {
            Keyboard.Focus(bad);
            return;
        }
        request.From = dates!.Value.From;
        request.To = dates.Value.To;
        await owner.StartAsync(request, this);
    }

    /// <summary>Holds the button down while a search is asked for.</summary>
    public bool Busy
    {
        set => submit.IsEnabled = !value;
    }

    /// <summary>A search that could not be started: said at the top of the form, where the focus goes.</summary>
    public void ShowError(string message)
    {
        errorBox.Child = Build.Callout("error", T["error.title"], Build.Text(message));
        errorBox.Margin = new Thickness(0, 0, 0, 16);
        errorBox.Visibility = Visibility.Visible;
        Keyboard.Focus(errorBox);
        Announce.Alert(message);
    }

    void ClearError()
    {
        errorBox.Child = null;
        errorBox.Visibility = Visibility.Collapsed;
    }

    // ---- for the pictures of the window -------------------------------------------------------

    public void Pick(string choice) => when.Value = choice;

    public void OpenMore() => more.IsExpanded = true;

    public void SetTypes(bool photo, bool video)
    {
        photos.IsChecked = photo;
        videos.IsChecked = video;
    }

    public void SetWhere(string text) => whereBox.Text = text;

    public void SetDates(DateTime? f, DateTime? t)
    {
        fromBox.SelectedDate = f;
        toBox.SelectedDate = t;
    }

    public Task SubmitForShotAsync() => SubmitAsync();
}
