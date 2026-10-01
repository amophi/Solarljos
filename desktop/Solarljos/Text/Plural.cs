namespace Solarljos.Text;

/// <summary>
/// The plural form of a whole number in each language Solarljos speaks, by CLDR's rules for
/// integers -- what the page asks Intl.PluralRules for (src/gui/ui/app.js). Only whole numbers
/// are ever counted: files, copies, places.
/// </summary>
public static class Plural
{
    public static string Select(string language, long n)
    {
        long i = Math.Abs(n);
        string lang = language.Split('-')[0].ToLowerInvariant();
        switch (lang)
        {
            case "en":
            case "de":
            case "tr":
                return i == 1 ? "one" : "other";
            case "hi":
                return i <= 1 ? "one" : "other";
            case "es":
            case "it":
                return i == 1 ? "one" : Million(i) ? "many" : "other";
            case "fr":
            case "pt":
                return i <= 1 ? "one" : Million(i) ? "many" : "other";
            case "ru":
                if (i % 10 == 1 && i % 100 != 11) return "one";
                if (i % 10 is >= 2 and <= 4 && i % 100 is < 12 or > 14) return "few";
                return "many";
            case "pl":
                if (i == 1) return "one";
                if (i % 10 is >= 2 and <= 4 && i % 100 is < 12 or > 14) return "few";
                return "many";
            case "ar":
                if (i == 0) return "zero";
                if (i == 1) return "one";
                if (i == 2) return "two";
                if (i % 100 is >= 3 and <= 10) return "few";
                if (i % 100 is >= 11 and <= 99) return "many";
                return "other";
            default:
                // ko ja zh th vi id: one form for every number.
                return "other";
        }
    }

    // "1 000 000 de fichiers": Spanish, French, Italian and Portuguese have a form for millions.
    static bool Million(long i) => i != 0 && i % 1_000_000 == 0;
}
