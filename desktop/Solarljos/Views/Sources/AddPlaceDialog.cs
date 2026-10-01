using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;

namespace Solarljos.Views.Sources;

/// <summary>
/// A place to add to one source for this run (addPlace in viewSources, app.js): a folder on
/// another disk, a memory card's image or drive letter, a folder to look through in every restore
/// point. Typed or pasted -- there is no folder picker, since Windows' own shows the folders'
/// pictures and writes them into the very thumbnail cache a search for photos reads -- and taken
/// only when it is given whole, from its drive letter on. Nothing is written: the place is kept
/// in the session's memory, by the view that asked.
/// </summary>
public sealed class AddPlaceDialog : Window
{
    static Tr T => Tr.Instance;

    readonly string sourceId;
    readonly TextBox input = Build.PathBox();
    readonly Build.Field field;

    /// <summary>The place to add, as a search sends it ("walk=" and the folder, for restore points); null when none was.</summary>
    public string? Place { get; private set; }

    public AddPlaceDialog(Window owner, Session.SourceInfo source)
    {
        sourceId = source.Id;
        Owner = owner;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        SizeToContent = SizeToContent.Height;
        Width = 600;
        ShowInTaskbar = false;
        FlowDirection = owner.FlowDirection;
        SetResourceReference(BackgroundProperty, "Card");
        SetResourceReference(ForegroundProperty, "Text");
        SetResourceReference(FontFamilyProperty, "UiFont");
        FontSize = 15;
        SourceInitialized += (_, _) => Theme.TitleBar(this, round: true);

        var title = T.Get("sources.addTitle", ("source", Formats.SourceLabel(source.Id, source.Label)));
        Title = title;
        // A source can have words of its own for what a place of it is: a restore point's folder, a card's image.
        string ownOr(string key, string fallback) => T.Has(key) ? key : fallback;
        var hint = T[ownOr($"sources.addHint.{source.Id}", "sources.addHint")] + " " + T["common.pathTip"];
        field = Build.LabeledField(T[ownOr($"sources.addLabel.{source.Id}", "sources.addPlace.label")], input, hint);
        field.El.Margin = new Thickness(0, 16, 0, 0);

        var submit = Build.Button(T["sources.addSubmit"], Submit, "BtnPrimary");
        submit.IsDefault = true;
        var cancel = Build.Button(T["common.cancel"], Close);
        cancel.IsCancel = true;
        foreach (var b in new[] { cancel, submit })
        {
            b.MinHeight = 48;
            b.MinWidth = 120;
            b.FontSize = 16;
            Look.SetRadius(b, new CornerRadius(14));
        }
        cancel.Margin = new Thickness(0, 0, 8, 0);
        var buttons = Build.Stack(Orientation.Horizontal, cancel, submit);
        buttons.HorizontalAlignment = HorizontalAlignment.Right;
        buttons.Margin = new Thickness(0, 24, 0, 0);

        Content = new Border { Child = Build.Stack(Build.Heading(title, 2), field.El, buttons), Padding = new Thickness(28, 24, 28, 24) };
        Loaded += (_, _) => Keyboard.Focus(input);
    }

    /// <summary>For the pictures of the window: what is typed, then Add, as if pressed.</summary>
    public void Type(string text, bool submit)
    {
        input.Text = text;
        input.CaretIndex = text.Length;
        if (submit) Submit();
    }

    void Submit()
    {
        var typed = Paths.Unquote(input.Text);
        if (typed.Length == 0 || !Paths.IsAbsolute(typed))
        {
            field.SetError(T[typed.Length > 0 ? "dest.relative" : "dest.missing"]);
            input.Focus();
            return;
        }
        Place = sourceId == "vss" ? "walk=" + typed : typed;
        Close();
    }
}
