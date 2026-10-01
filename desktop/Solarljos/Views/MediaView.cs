using System.Windows.Controls;
using Solarljos.Core;
using Solarljos.Text;

namespace Solarljos.Views;

/// <summary>The part of the window for nav.media: still to be made (see the brief in the scratchpad).</summary>
public sealed class MediaView : UserControl, IPage
{
    public event Action? HeadingChanged;

    public MediaView()
    {
        Content = Ui.Build.Page(Ui.Build.Heading(Tr.Instance["nav.media"]));
        Tr.Instance.Changed += () =>
        {
            Content = Ui.Build.Page(Ui.Build.Heading(Tr.Instance["nav.media"]));
            HeadingChanged?.Invoke();
        };
    }

    public string? Heading => Tr.Instance["nav.media"];

    public void Connected(Session session) { }

    public void Shown(string sub) { }
}
