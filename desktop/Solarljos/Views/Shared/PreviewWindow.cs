using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Solarljos.Core;
using Solarljos.Text;
using Solarljos.Ui;
using Solarljos.Views.Find;

namespace Solarljos.Views.Shared;

/// <summary>
/// A copy shown on its own, over the part that asked -- a file of a folder's plan: the same
/// preview the results show beside them (Find/PreviewPanel), in a window owned by the program's
/// and modal to it. Esc closes it, and the focus goes back to what opened it; Restore asks where,
/// as everywhere else.
/// </summary>
public sealed class PreviewWindow : Window
{
    readonly PreviewPanel panel;

    PreviewWindow(Window owner, Session session, Copy copy)
    {
        Owner = owner;
        Title = copy.Name ?? Tr.Instance["results.nameUnknown"];
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ShowInTaskbar = false;
        Width = Math.Min(760, owner.ActualWidth - 48);
        Height = Math.Max(420, owner.ActualHeight - 64);
        FlowDirection = owner.FlowDirection;
        SetResourceReference(BackgroundProperty, "Card");
        SetResourceReference(ForegroundProperty, "Text");
        SetResourceReference(FontFamilyProperty, "UiFont");
        FontSize = 15;
        SourceInitialized += (_, _) => Theme.TitleBar(this, round: true);
        // The preview's look -- its tabs, a copy's text, a video's line -- is Find a file's, which a window of its own does not inherit.
        Resources.MergedDictionaries.Add(new ResourceDictionary { Source = new Uri("/Solarljos;component/Views/Find/FindStyles.xaml", UriKind.Relative) });
        panel = new PreviewPanel(session, copy, Close, 0, (c) => new RestoreDialog(this, session, [c]).ShowDialog());
        Content = new ScrollViewer
        {
            Content = new Border { Child = panel, Padding = new Thickness(24) },
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
        };
        // Esc closes it once what has the focus has not taken the key: an open list of encodings closes first, not the whole window.
        KeyDown += (_, e) =>
        {
            if (e.Key != Key.Escape || e.Handled) return;
            e.Handled = true;
            Close();
        };
        Loaded += (_, _) => panel.FocusHeading();
        Closed += (_, _) => panel.Destroy();
    }

    /// <summary>Shows a copy, and gives the focus back to `opener` once it is closed.</summary>
    public static void Show(Session session, Copy copy, FrameworkElement opener)
    {
        if (Window.GetWindow(opener) is not { } owner) return;
        new PreviewWindow(owner, session, copy).ShowDialog();
        opener.Focus();
    }
}
