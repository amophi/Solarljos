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

namespace Solarljos.Views.Folder;

/// <summary>
/// Bring back a folder: which folder it was, typed as it was, whole; only what is missing now;
/// only versions from a day on; and under More options the places to search and another disk
/// (viewFolderForm in src/gui/ui/app.js). Its heading has a way back to the plan it led to while
/// that is kept. A failure to start is said at the top of the form.
/// </summary>
sealed class FolderForm : Part
{
    static Tr T => Tr.Instance;

    readonly FolderView owner;
    readonly TextBox folder;
    readonly Build.Field folderField;
    readonly Build.SwitchRow deletedOnly;
    readonly DatePicker since;
    readonly Build.Field sinceField;
    readonly string sinceFormat;
    // What the day's box showed when it last set its day itself, and what it was given that it
    // could not read and so left empty, until something else is typed.
    string shown = "";
    string? unread;
    // What was typed in it, when the form is made again in another language: the box is given it as typed.
    string? typedBack;
    readonly PlacesField places;
    readonly OtherDiskField disk;
    readonly Expander more;
    readonly Button submit;
    readonly Labeled errorBox = new() { Visibility = Visibility.Collapsed, Focusable = true, FocusVisualStyle = null, Margin = new Thickness(0, 0, 0, 16) };
    readonly Button back;
    readonly TextBlock backText = new() { VerticalAlignment = VerticalAlignment.Center };
    string? folderError;

    public FolderForm(FolderView owner, FolderRequest last)
    {
        this.owner = owner;
        Heading = T["folder.title"];
        folder = Build.PathBox(last.Folder);
        folderField = Build.LabeledField(T["folder.path.label"], folder, T["folder.path.hint"] + " " + T["common.pathTip"]);
        deletedOnly = Build.Switch(T["folder.deletedOnly.label"], last.DeletedOnly, T["folder.deletedOnly.hint"]);
        // The day, chosen on its calendar or typed, as Find a file's is (the page's input type=date).
        since = new DatePicker();
        since.SetResourceReference(FrameworkElement.StyleProperty, "FindDate");
        since.Language = XmlLanguage.GetLanguage(T.Culture.IetfLanguageTag);
        since.SelectedDateChanged += (_, _) => shown = since.Text ?? "";
        since.DateValidationError += (_, e) =>
        {
            e.ThrowException = false;
            unread = e.Text;
        };
        if (FolderRequest.DayStart(last.SinceDate) is { } ms) since.SelectedDate = DateTimeOffset.FromUnixTimeMilliseconds(ms).LocalDateTime.Date;
        else if (last.SinceDate.Length > 0) typedBack = last.SinceDate;
        sinceFormat = T.Get("desktop.folder.since.format", ("example", Formats.Ymd(DateTimeOffset.Now)));
        sinceField = Build.LabeledField(T["folder.since.label"], since, T["folder.since.hint"] + " " + sinceFormat, optional: true);
        since.Loaded += (_, _) =>
        {
            // The calendar's button, which the template has; named here, in the program's words.
            if (since.Template?.FindName("PART_Button", since) is Button b)
            {
                AutomationProperties.SetName(b, T["desktop.calendar"]);
                b.ToolTip = T["desktop.calendar"];
            }
            // And its box, which the focus goes to: named as the day is, and told what is wrong with it.
            if (SinceBox() is not { } box) return;
            SayDay();
            if (typedBack is { } typed) box.Text = typed;
            typedBack = null;
            box.TextChanged += (_, _) =>
            {
                if (box.Text.Trim().Length > 0) unread = null;
            };
        };
        places = new PlacesField("folder", last.Sources?.ToList());
        disk = new OtherDiskField();

        // What is typed is checked as it is typed, quietly: said aloud only when the form is sent.
        folder.TextChanged += (_, _) =>
        {
            var v = folder.Text.Trim();
            SetQuietly(folderField, v.Length > 0 && !Paths.IsAbsolute(Paths.Unquote(v)) ? T["folder.path.relative"] : null);
        };

        submit = Build.Button(T["folder.submit"], async () => await SubmitAsync(), "BtnLarge");
        more = Build.More(T["common.advanced"], last.More, false, places.El, disk.El);
        sinceField.El.Margin = new Thickness(0);
        deletedOnly.El.Margin = new Thickness(-16, -14, -16, -14);
        var pair = Build.Pair(deletedOnly.El, sinceField.El);
        var actions = Build.Stack(submit);
        actions.Margin = new Thickness(0, 32, 0, 0);
        var form = Build.Card(Build.Stack(errorBox, folderField.El, pair, more, actions), 32);
        AutomationProperties.SetName(form, T["folder.title"]);
        // Enter in a box of the form sends it, as a form's Enter does.
        form.PreviewKeyDown += async (_, e) =>
        {
            if (e.Key == Key.Enter && e.OriginalSource is TextBox && Keyboard.Modifiers == ModifierKeys.None)
            {
                e.Handled = true;
                await SubmitAsync();
            }
        };

        // A way back to the plan this form led to, while it is kept.
        var chevron = new Icon { Glyph = "chevron", Width = 16, Height = 16, Margin = new Thickness(4, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
        back = new Button { Content = Build.Stack(Orientation.Horizontal, backText, chevron), VerticalAlignment = VerticalAlignment.Top, Padding = new Thickness(16, 8, 10, 8) };
        back.SetResourceReference(FrameworkElement.StyleProperty, "Btn");
        back.Click += (_, _) => owner.Go("plan", focus: true);
        var title = Build.Heading(Heading);
        var head = new DockPanel { Margin = new Thickness(0, 8, 0, 24) };
        DockPanel.SetDock(back, Dock.Right);
        back.Margin = new Thickness(16, 2, 0, 0);
        head.Children.Add(back);
        head.Children.Add(title);
        UpdateBack();
        El = Build.Page(Build.Stack(head, form));
    }

    /// <summary>The way back says where it goes: to the search under way, or to its results.</summary>
    void UpdateBack()
    {
        var job = App.Session?.Jobs.Current("folder");
        back.Visibility = job is null ? Visibility.Collapsed : Visibility.Visible;
        backText.Text = job is { Running: true } ? T["form.toSearch"] : T["form.toResults"];
        AutomationProperties.SetName(back, backText.Text);
    }

    public override void OnShow()
    {
        UpdateBack();
        disk.Update();
    }

    public override void Update() => UpdateBack();

    /// <summary>What the form holds, as typed.</summary>
    public FolderRequest Values() => new()
    {
        Folder = folder.Text, DeletedOnly = deletedOnly.IsOn, SinceDate = Day(), Sources = places.Value(), More = more.IsExpanded,
    };

    /// <summary>The day's box inside its picker, once it is made.</summary>
    TextBox? SinceBox()
    {
        since.ApplyTemplate();
        return since.Template?.FindName("PART_TextBox", since) as TextBox;
    }

    /// <summary>The day's box says what the day's field does: its name, its words and what is wrong.</summary>
    void SayDay()
    {
        if (SinceBox() is not { } box) return;
        AutomationProperties.SetName(box, AutomationProperties.GetName(since));
        AutomationProperties.SetLabeledBy(box, AutomationProperties.GetLabeledBy(since));
        AutomationProperties.SetHelpText(box, AutomationProperties.GetHelpText(since));
    }

    /// <summary>
    /// The day as the box holds it: the one it set itself -- chosen on its calendar, or typed and
    /// read as the language writes days -- as year-month-day; else what is typed, as typed.
    /// </summary>
    string Day()
    {
        var text = since.Text ?? "";
        return since.SelectedDate is { } day && text.Trim().Length > 0 && text.Trim() == shown.Trim()
            ? day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : text;
    }

    public override object? Save() => Values();

    /// <summary>An error below a box, without saying it aloud: for what is checked as it is typed.</summary>
    void SetQuietly(Build.Field f, string? message)
    {
        if (f == folderField)
        {
            if (folderError == message) return;
            folderError = message;
        }
        f.Error.Text = message is null ? "" : "! " + message;
        f.Error.Visibility = message is null ? Visibility.Collapsed : Visibility.Visible;
        AutomationProperties.SetHelpText(f.Control, string.Join(" ", new[] { message, f.Hint }.Where((s) => !string.IsNullOrEmpty(s))));
    }

    async Task SubmitAsync()
    {
        if (!submit.IsEnabled) return;
        var v = folder.Text.Trim();
        var sinceDate = Day().Trim();
        long? sinceMs = sinceDate.Length > 0 ? FolderRequest.DayStart(sinceDate) : null;
        Control? bad = null;
        var folderMessage = v.Length == 0 ? T["folder.path.missing"] : !Paths.IsAbsolute(Paths.Unquote(v)) ? T["folder.path.relative"] : null;
        folderError = folderMessage;
        folderField.SetError(folderMessage);
        if (folderMessage is not null) bad = folder;
        // A day that does not exist is said so, as the page says it; one written another way, or
        // one the box could not read and dropped, how to write it -- the latter once.
        var dayMessage = sinceDate.Length > 0
            ? sinceMs is not null ? null : FolderRequest.DayShaped(sinceDate) ? T["find.since.missing"] : sinceFormat
            : unread is not null ? sinceFormat : null;
        unread = null;
        sinceField.SetError(dayMessage);
        SayDay();
        if (dayMessage is not null) bad ??= since;
        if (bad is null && places.Validate() is { } none)
        {
            // The places are under More options: it opens, so that the box the focus goes to is in sight.
            more.IsExpanded = true;
            bad = none;
        }
        if (bad is not null)
        {
            bad.Focus();
            return;
        }
        ClearError();
        if (App.Session is null)
        {
            ShowError(T["desktop.starting"]);
            return;
        }
        submit.IsEnabled = false;
        try
        {
            await owner.StartPlanAsync(new FolderRequest
            {
                Folder = v, DeletedOnly = deletedOnly.IsOn, SinceDate = sinceDate, Since = sinceMs, Sources = places.Value(), More = more.IsExpanded,
            }, fromForm: true);
        }
        catch (Exception e) when (e is CoreException or HttpRequestException)
        {
            ShowError(Formats.ErrorText(e));
        }
        finally
        {
            submit.IsEnabled = true;
        }
    }

    /// <summary>What went wrong, at the top of the form, where the focus goes (formError in app.js).</summary>
    void ShowError(string text)
    {
        errorBox.Child = Build.Callout("error", T["error.title"], Build.Text(text, "Body"));
        AutomationProperties.SetName(errorBox, T["error.title"] + " " + text);
        errorBox.Visibility = Visibility.Visible;
        errorBox.Focus();
        Announce.Alert(text);
    }

    void ClearError()
    {
        errorBox.Visibility = Visibility.Collapsed;
        errorBox.Child = null;
    }

    /// <summary>For the pictures: what is typed in the box of the folder.</summary>
    public void Type(string path) => folder.Text = path;

    /// <summary>For the pictures: a day typed in its box, as the keyboard types it, not yet read by the box.</summary>
    public void TypeSince(string day)
    {
        if (SinceBox() is { } box) box.Text = day;
        else since.Text = day;
    }

    public Task SendAsync() => SubmitAsync();

    public void OpenMore() => more.IsExpanded = true;
}
