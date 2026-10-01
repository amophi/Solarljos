using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;

namespace Solarljos.Ui;

/// <summary>
/// The theme, dark as SoundVisualizer is unless light is chosen, and the font of the language.
/// Nothing is kept on disk: Solarljos writes nothing but what is restored, so each run starts dark,
/// in the language Windows is set to.
/// </summary>
public static class Theme
{
    public static bool Dark { get; private set; } = true;

    public static event Action? Changed;

    public static void Use(bool dark)
    {
        Dark = dark;
        var dictionaries = Application.Current.Resources.MergedDictionaries;
        dictionaries[0] = new ResourceDictionary { Source = new Uri(dark ? "Theme/Dark.xaml" : "Theme/Light.xaml", UriKind.Relative) };
        foreach (Window w in Application.Current.Windows) TitleBar(w);
        Changed?.Invoke();
    }

    /// <summary>
    /// The font for a language: Pretendard, which the program carries, for Latin, Greek, Cyrillic
    /// and Korean, and each language's own Windows font after it for the rest; Japanese and
    /// Chinese in their own fonts from the start, so that a sentence is drawn in one hand (the page
    /// does the same with unicode-range: src/gui/ui/style.css).
    /// </summary>
    public static void UseFontFor(string code)
    {
        string list = code switch
        {
            "ja" => "Yu Gothic UI, Meiryo UI, Segoe UI",
            "zh-CN" => "Microsoft YaHei UI, Segoe UI",
            "zh-TW" => "Microsoft JhengHei UI, Segoe UI",
            _ => "./Fonts/#Pretendard, Segoe UI, Malgun Gothic, Leelawadee UI, Nirmala UI",
        };
        Application.Current.Resources["UiFont"] = new FontFamily(new Uri("pack://application:,,,/"), list);
    }

    // ---- the window's own title bar, in the theme's colours (Windows 11; ignored before it) ----

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    const int DWMWA_CAPTION_COLOR = 35;

    /// <summary>The title bar dark or light, in the rail's colour; round corners for a dialog.</summary>
    public static void TitleBar(Window w, bool round = false)
    {
        var hwnd = new WindowInteropHelper(w).Handle;
        if (hwnd == IntPtr.Zero) return;
        int dark = Dark ? 1 : 0;
        DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, sizeof(int));
        // COLORREF is 0x00BBGGRR: the rail's colour, #1E2024 dark, white light.
        int caption = Dark ? 0x0024201E : 0x00FFFFFF;
        DwmSetWindowAttribute(hwnd, DWMWA_CAPTION_COLOR, ref caption, sizeof(int));
        if (round)
        {
            int corner = 2; // DWMWCP_ROUND
            DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref corner, sizeof(int));
        }
    }
}
