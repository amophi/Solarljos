using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

namespace Solarljos.Ui;

/// <summary>
/// A question with two answers, as the page's dialogs ask it: a title, what it means, and the
/// answer that does it, in red when it cannot be undone, beside the one that does not. Its own
/// window, owned by the program's and modal to it, so that Windows and assistive technology know
/// it as a dialog; Esc and the window's close answer no, and the no is where the keyboard starts.
/// </summary>
public static class Dialog
{
    /// <summary>Says something that needs only to be read: one button, which Esc presses too.</summary>
    public static Task<bool> InformAsync(Window owner, string title, string body, string ok) => ConfirmAsync(owner, title, body, ok, null);

    public static Task<bool> ConfirmAsync(Window owner, string title, string body, string ok, string? cancel, bool danger = false)
    {
        var w = new Window
        {
            Owner = owner,
            Title = title,
            WindowStyle = WindowStyle.SingleBorderWindow,
            ResizeMode = ResizeMode.NoResize,
            SizeToContent = SizeToContent.WidthAndHeight,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            ShowInTaskbar = false,
            MaxWidth = 560,
            FlowDirection = owner.FlowDirection,
        };
        w.SetResourceReference(Control.BackgroundProperty, "Card");
        w.SetResourceReference(Control.ForegroundProperty, "Text");
        w.SetResourceReference(Control.FontFamilyProperty, "UiFont");
        w.FontSize = 15;
        w.SourceInitialized += (_, _) => Theme.TitleBar(w, round: true);

        var heading = new TextBlock { Text = title };
        heading.SetResourceReference(FrameworkElement.StyleProperty, "H2");
        var text = new TextBlock { Text = body, Margin = new Thickness(0, 8, 0, 0) };
        text.SetResourceReference(FrameworkElement.StyleProperty, "Muted");
        var no = new Button { Content = cancel, IsCancel = true, MinWidth = 120, Margin = new Thickness(0, 0, 8, 0) };
        no.SetResourceReference(FrameworkElement.StyleProperty, "Btn");
        var yes = new Button { Content = ok, MinWidth = 120 };
        yes.SetResourceReference(FrameworkElement.StyleProperty, danger ? "BtnDanger" : "BtnPrimary");
        bool answer = false;
        yes.Click += (_, _) =>
        {
            answer = true;
            w.Close();
        };
        if (cancel is null) yes.IsCancel = true;
        foreach (var b in new[] { no, yes })
        {
            b.MinHeight = 48;
            b.FontSize = 16;
            Look.SetRadius(b, new CornerRadius(14));
        }
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 24, 0, 0) };
        if (cancel is not null) buttons.Children.Add(no);
        buttons.Children.Add(yes);
        var stack = new StackPanel { Margin = new Thickness(28, 24, 28, 24), MinWidth = 380 };
        stack.Children.Add(heading);
        stack.Children.Add(text);
        stack.Children.Add(buttons);
        w.Content = stack;
        w.Loaded += (_, _) => Keyboard.Focus(cancel is null ? yes : no);
        w.ShowDialog();
        return Task.FromResult(answer);
    }
}
