using System.Windows.Data;
using System.Windows.Markup;
using Solarljos.Text;

namespace Solarljos.Ui;

/// <summary>
/// A string of the tables by key, in XAML: Text="{u:T nav.find}". It is a binding to Tr's
/// indexer, so it follows the language when it changes.
/// </summary>
[MarkupExtensionReturnType(typeof(object))]
public sealed class T : MarkupExtension
{
    public T() { }

    public T(string key) => Key = key;

    [ConstructorArgument("key")]
    public string Key { get; set; } = "";

    public override object ProvideValue(IServiceProvider serviceProvider)
    {
        var binding = new Binding($"[{Key}]") { Source = Tr.Instance, Mode = BindingMode.OneWay };
        return binding.ProvideValue(serviceProvider);
    }
}
