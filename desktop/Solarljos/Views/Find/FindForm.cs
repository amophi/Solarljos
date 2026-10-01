using System.Globalization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;
using Solarljos.Views.Shared;

namespace Solarljos.Views.Find;

/// <summary>
/// Find a file (viewFindForm in app.js): a name, or part of it; where it was and a word it held,
/// if they are remembered; only what is gone now. Under More options, the dates, the kind of file,
/// the places to search, and the places from another disk. It starts from what was last searched
/// for here, or from what it held when it is made again in another language.
/// </summary>
public sealed class FindForm : UserControl
{
    static Tr T => Tr.Instance;

    static readonly string[] Categories = ["document", "image", "video", "audio", "archive", "text"];

    readonly Func<Job?> current;
    readonly Func<FindRequest, Task<bool>> start;
    readonly TextBlock heading;
    readonly Button back;
    readonly TextBox name;
    readonly TextBox where;
    readonly TextBox containing;
    readonly Build.Field nameField, whereField, containingField, sinceField;
    readonly Build.SwitchRow deletedOnly;
    readonly Build.Chips since;
    readonly DatePicker sinceDate;
    readonly ComboBox type;
    readonly PlacesField places;
    readonly OtherDiskField disk;
    readonly Expander more;
    readonly Button submit;
    readonly Labeled errorBox = new() { Focusable = true, Visibility = Visibility.Collapsed, FocusVisualStyle = null, Margin = new Thickness(0, 0, 0, 16) };

    public ScrollViewer Scroller { get; }

    public string Heading => T["find.title"];

    public FindForm(FindRequest last, Func<Job?> current, Func<FindRequest, Task<bool>> start, Action toResults)
    {
        this.current = current;
        this.start = start;
        heading = Build.Heading(T["find.title"]);
        heading.Focusable = true;
        heading.FocusVisualStyle = null;
        KeyboardNavigation.SetIsTabStop(heading, false);
        heading.VerticalAlignment = VerticalAlignment.Center;
        back = new Button();
        back.SetResourceReference(StyleProperty, "Btn");
        back.Padding = new Thickness(16, 8, 10, 8);
        back.Click += (_, _) => toResults();
        back.Margin = new Thickness(0, 2, 0, 0);
        var head = Arrangement.HeadRow(heading, back);
        head.Margin = new Thickness(0, 8, 0, 24);

        name = Build.Input(last.Name);
        nameField = Build.LabeledField(T["find.name.label"], name, T["find.name.hint"]);
        nameField.El.Margin = new Thickness(0, 0, 0, 16);
        where = Build.PathBox(last.Where);
        whereField = Build.LabeledField(T["find.where.label"], where, T["find.where.hint"] + " " + T["common.pathTip"], optional: true);
        containing = Build.Input(last.Containing);
        containingField = Build.LabeledField(T["find.containing.label"], containing, T["find.containing.hint"], optional: true);
        whereField.El.Margin = containingField.El.Margin = new Thickness(0);
        deletedOnly = Build.Switch(T["find.deletedOnly.label"], last.DeletedOnly, T["find.deletedOnly.hint"]);
        deletedOnly.El.Margin = new Thickness(-16, -14, -16, -14);

        // The dates, the folder and only-deleted filter what a search found; the engine is sent none of them.
        since = Build.ChipGroup(T["find.since.label"], [
            ("any", T["find.since.any"]), ("day", T["find.since.day"]), ("week", T["find.since.week"]),
            ("month", T["find.since.month"]), ("pick", T["find.since.pick"]),
        ], last.SinceChoice is { Length: > 0 } sc ? sc : "any", T["find.since.hint"]);
        sinceDate = new DatePicker();
        sinceDate.SetResourceReference(StyleProperty, "FindDate");
        sinceDate.Language = XmlLanguage.GetLanguage(T.Culture.IetfLanguageTag);
        if (FindRequest.DayStart(last.SinceDate) is { } ms) sinceDate.SelectedDate = DateTimeOffset.FromUnixTimeMilliseconds((long)ms).LocalDateTime.Date;
        sinceField = Build.LabeledField(T["find.since.date"], sinceDate);
        sinceField.El.Margin = new Thickness(0, 16, 0, 0);
        sinceDate.Loaded += (_, _) =>
        {
            // The calendar's button, which the template has; named here, in the program's words.
            if (sinceDate.Template?.FindName("PART_Button", sinceDate) is Button b)
            {
                AutomationProperties.SetName(b, T["desktop.find.calendar"]);
                b.ToolTip = T["desktop.find.calendar"];
            }
        };
        void syncSince() => sinceField.El.Visibility = since.Value == "pick" ? Visibility.Visible : Visibility.Collapsed;
        since.Changed += syncSince;
        syncSince();

        var kinds = new List<(string, string)> { ("", T["find.type.any"]) };
        kinds.AddRange(Categories.Select((k) => (k, T["type." + k])));
        type = Build.Select(kinds, last.Types.FirstOrDefault() ?? "", T["find.type.label"]);
        var typeField = Build.LabeledField(T["find.type.label"], type);
        typeField.El.Margin = new Thickness(0);
        places = new PlacesField("name", last.Sources);
        disk = new OtherDiskField();

        submit = Build.Button(T["find.submit"], async () => await SubmitAsync(), "BtnLarge");
        submit.Margin = new Thickness(0, 32, 0, 0);
        // Open as it was left; else open when something in it was chosen.
        bool open = last.More ?? (last.SinceChoice is not ("any" or "") || last.Sources is not null || last.Types.Count > 0);
        var timePair = Build.Pair(Build.Stack(since.El, sinceField.El), typeField.El);
        more = Build.More(T["common.advanced"], open, false, timePair, places.El, disk.El);

        var form = Build.Stack(errorBox, nameField.El, Build.Pair(whereField.El, containingField.El), Build.Pair(deletedOnly.El), more, submit);
        // Enter in a box sends the form, as it does on the page.
        form.PreviewKeyDown += async (_, e) =>
        {
            if (e.Key != Key.Enter || Keyboard.Modifiers != ModifierKeys.None) return;
            if (e.OriginalSource is not TextBox) return;
            e.Handled = true;
            await SubmitAsync();
        };
        var card = Build.Card(form, 32);
        Scroller = Build.Page(Build.Stack(head, card));
        Content = Scroller;
        SizeChanged += (_, _) =>
        {
            // A narrow window, as the page's 700 pixels: less room around the form.
            bool narrow = (Window.GetWindow(this)?.ActualWidth ?? ActualWidth) < 700;
            card.Padding = new Thickness(narrow ? 20 : 32);
        };
        Update();
        // Sent here to search by content instead: start in that box, once it is in sight.
        if (last.Focus == "containing") Loaded += FocusContainingOnce;
    }

    void FocusContainingOnce(object? sender, RoutedEventArgs e)
    {
        Loaded -= FocusContainingOnce;
        Dispatcher.BeginInvoke(() => containing.Focus(), System.Windows.Threading.DispatcherPriority.Input);
    }

    public void FocusHeading() => heading.Focus();

    public void FocusContaining() => containing.Focus();

    /// <summary>The way back to the results while there are some, and the places added, as they stand now.</summary>
    public void Update()
    {
        var job = current();
        back.Visibility = job is null ? Visibility.Collapsed : Visibility.Visible;
        if (job is not null)
        {
            var label = T[job.Running ? "form.toSearch" : "form.toResults"];
            var chevron = new Ui.Icon { Glyph = "chevron", Width = 16, Height = 16, Margin = new Thickness(4, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            back.Content = Build.Stack(Orientation.Horizontal, Build.Text(label, "Body").Bold(), chevron);
            AutomationProperties.SetName(back, label);
        }
        disk.Update();
    }

    /// <summary>The day typed or chosen, as the language writes days; null when none, or one that does not exist.</summary>
    DateTime? PickedDay()
    {
        var text = sinceDate.Text?.Trim() ?? "";
        if (text.Length == 0) return sinceDate.SelectedDate?.Date;
        if (DateTime.TryParse(text, T.Culture, DateTimeStyles.AllowWhiteSpaces, out var d)) return d.Date;
        if (DateTime.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var iso)) return iso.Date;
        return null;
    }

    /// <summary>What the form holds; `raw`, as typed, spaces and all.</summary>
    public FindRequest Values(bool raw)
    {
        string v(TextBox t) => raw ? t.Text : t.Text.Trim();
        return new FindRequest
        {
            Name = v(name),
            Containing = v(containing),
            Where = v(where),
            DeletedOnly = deletedOnly.IsOn,
            SinceChoice = since.Value is { Length: > 0 } c ? c : "any",
            SinceDate = PickedDay() is { } d ? d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : "",
            Types = type.SelectedValue is string { Length: > 0 } t ? [t] : [],
            Sources = places.Value(),
        };
    }

    /// <summary>The form as it is, for when it is made again.</summary>
    public FindRequest Save() => Values(true) with { More = more.IsExpanded };

    /// <summary>Sends the form, as its button does.</summary>
    public void Submit() => _ = SubmitAsync();

    async Task SubmitAsync()
    {
        if (!submit.IsEnabled) return;
        foreach (var f in new[] { nameField, whereField, sinceField }) f.SetError(null);
        var request = Values(false);
        request = request with { Since = FindRequest.SinceMs(request.SinceChoice, request.SinceDate) };
        UIElement? bad = null;
        if (request.Name.Length == 0 && request.Containing.Length == 0 && request.Types.Count == 0)
        {
            nameField.SetError(T["find.name.missing"]);
            bad ??= name;
        }
        if (request.Where.Length > 0 && !Paths.IsAbsolute(Paths.Unquote(request.Where)))
        {
            whereField.SetError(T["folder.path.relative"]);
            bad ??= where;
        }
        if (request.SinceChoice == "pick" && request.Since is null)
        {
            more.IsExpanded = true;
            sinceField.SetError(T["find.since.missing"]);
            bad ??= sinceDate;
        }
        if (places.Validate() is { } box)
        {
            more.IsExpanded = true;
            bad ??= box;
        }
        if (bad is not null)
        {
            bad.Focus();
            if (bad is FrameworkElement fe) fe.BringIntoView();
            return;
        }
        ClearError();
        submit.IsEnabled = false;
        try
        {
            await start(request with { Where = Paths.Unquote(request.Where) });
        }
        catch (Exception e) when (Arrangement.IsTrouble(e))
        {
            ShowError(Formats.ErrorText(e));
        }
        finally
        {
            submit.IsEnabled = true;
        }
    }

    /// <summary>Why the search did not start, at the top of the form, where the focus goes.</summary>
    public void ShowError(string message)
    {
        errorBox.Child = Build.Callout("error", T["error.title"], Build.Text(message, "Body")).Margin(0, 0, 0, 0);
        AutomationProperties.SetName(errorBox, message);
        errorBox.Visibility = Visibility.Visible;
        errorBox.Focus();
        errorBox.BringIntoView();
        Announce.Alert(message);
    }

    public void ClearError()
    {
        errorBox.Visibility = Visibility.Collapsed;
        errorBox.Child = null;
    }
}

static class TextBold
{
    public static TextBlock Bold(this TextBlock t)
    {
        t.FontWeight = FontWeights.Bold;
        return t;
    }
}
