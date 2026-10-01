using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Automation.Provider;
using System.Windows.Controls;

namespace Solarljos.Ui;

/// <summary>
/// A button that opens and closes something, and says which it is, as the page's aria-expanded
/// does: UI Automation's expand/collapse pattern, which a screen reader reads as "expanded" or
/// "collapsed" in its own language. Pressing it, or expanding it through UI Automation, clicks it.
/// </summary>
public class ExpandButton : Button
{
    public static readonly DependencyProperty IsExpandedProperty = DependencyProperty.Register(
        nameof(IsExpanded), typeof(bool), typeof(ExpandButton), new PropertyMetadata(false, (d, e) =>
        {
            if (UIElementAutomationPeer.FromElement((ExpandButton)d) is Peer p) p.Changed((bool)e.OldValue, (bool)e.NewValue);
        }));

    public bool IsExpanded { get => (bool)GetValue(IsExpandedProperty); set => SetValue(IsExpandedProperty, value); }

    protected override AutomationPeer OnCreateAutomationPeer() => new Peer(this);

    sealed class Peer(ExpandButton owner) : ButtonAutomationPeer(owner), IExpandCollapseProvider
    {
        public override object GetPattern(PatternInterface pattern) =>
            pattern == PatternInterface.ExpandCollapse ? this : base.GetPattern(pattern);

        static ExpandCollapseState Of(bool expanded) => expanded ? ExpandCollapseState.Expanded : ExpandCollapseState.Collapsed;

        public ExpandCollapseState ExpandCollapseState => Of(owner.IsExpanded);

        public void Expand()
        {
            if (!owner.IsExpanded) Press();
        }

        public void Collapse()
        {
            if (owner.IsExpanded) Press();
        }

        void Press() => ((IInvokeProvider)this).Invoke();

        public void Changed(bool was, bool now) =>
            RaisePropertyChangedEvent(ExpandCollapsePatternIdentifiers.ExpandCollapseStateProperty, Of(was), Of(now));
    }
}
