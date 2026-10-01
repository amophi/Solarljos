using System.Windows.Controls;
using Solarljos.Core;
using Solarljos.Text;

namespace Solarljos.Views;

/// <summary>The part of the window for nav.folder: still to be made (see the brief in the scratchpad).</summary>
public sealed class FolderView : UserControl, IPage
{
    public event Action? HeadingChanged;

    public FolderView()
    {
        Content = Ui.Build.Page(Ui.Build.Heading(Tr.Instance["nav.folder"]));
        Tr.Instance.Changed += () =>
        {
            Content = Ui.Build.Page(Ui.Build.Heading(Tr.Instance["nav.folder"]));
            HeadingChanged?.Invoke();
        };
    }

    public string? Heading => Tr.Instance["nav.folder"];

    public void Connected(Session session) { }

    public void Shown(string sub) { }
}
