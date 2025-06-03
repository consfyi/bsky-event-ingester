use crate::roman;

pub fn guess_language_for_region(
    region: icu_locale::subtags::Region,
) -> icu_locale::LanguageIdentifier {
    const LOCALE_EXPANDER: icu_locale::LocaleExpander = icu_locale::LocaleExpander::new_common();
    let mut langid = icu_locale::LanguageIdentifier::UNKNOWN;
    langid.region = Some(region);
    LOCALE_EXPANDER.maximize(&mut langid);
    langid
}

fn map_cow<'a, T>(
    input: std::borrow::Cow<'a, T>,
    f: impl for<'b> Fn(&'b T) -> std::borrow::Cow<'b, T>,
) -> std::borrow::Cow<'a, T>
where
    T: ToOwned + ?Sized,
{
    match input {
        std::borrow::Cow::Borrowed(b) => f(b),
        std::borrow::Cow::Owned(o) => {
            use std::borrow::Borrow as _;
            std::borrow::Cow::Owned(f(o.borrow()).into_owned())
        }
    }
}

pub fn to_lower<'a>(
    s: &'a str,
    langid: &icu_locale::LanguageIdentifier,
) -> std::borrow::Cow<'a, str> {
    const CASE_MAPPER: icu_casemap::CaseMapperBorrowed<'static> = icu_casemap::CaseMapper::new();
    const NORMALIZER: icu_normalizer::ComposingNormalizerBorrowed<'static> =
        icu_normalizer::ComposingNormalizer::new_nfkc();
    map_cow(NORMALIZER.normalize(s), |s| {
        CASE_MAPPER.lowercase_to_string(s, langid)
    })
}

pub fn slugify(s: &str, langid: &icu_locale::LanguageIdentifier) -> String {
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"[^\p{L}\p{N}\s-]+").unwrap());
    RE.replace_all(&to_lower(s, langid), "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
}

pub fn slugify_for_label(s: &str, langid: &icu_locale::LanguageIdentifier) -> String {
    static NUMBERS_RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\d+").unwrap());
    static ALLOWED_CHARS_RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"[^a-z -]").unwrap());
    ALLOWED_CHARS_RE
        .replace_all(
            &NUMBERS_RE.replace_all(
                &deunicode::deunicode(&to_lower(s, langid)),
                |caps: &regex::Captures| {
                    format!(
                        " {} ",
                        roman::to_roman(caps[0].parse().unwrap()).to_lowercase()
                    )
                },
            ),
            "",
        )
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_slugify() {
        assert_eq!(
            slugify("Anthrocon", &icu_locale::langid!("en-US")),
            "anthrocon"
        );

        assert_eq!(slugify("2Dance", &icu_locale::langid!("en-DE")), "2dance");

        assert_eq!(
            slugify("Futrołajki", &icu_locale::langid!("pl-PL")),
            "futrołajki"
        );

        assert_eq!(
            slugify("Örli Försztivál", &icu_locale::langid!("hu-HU")),
            "örli-försztivál"
        );

        assert_eq!(
            slugify("んなモフ", &icu_locale::langid!("ja-JP")),
            "んなモフ"
        );

        assert_eq!(slugify("Fur-Eh!", &icu_locale::langid!("en-CA")), "fur-eh");
    }

    #[test]
    fn test_slugify_for_label() {
        assert_eq!(
            slugify_for_label("Anthrocon", &icu_locale::langid!("en-US")),
            "anthrocon"
        );

        assert_eq!(
            slugify_for_label("2Dance", &icu_locale::langid!("en-DE")),
            "ii-dance"
        );

        assert_eq!(
            slugify_for_label("A2B", &icu_locale::langid!("en-US")),
            "a-ii-b"
        );

        assert_eq!(
            slugify_for_label("Futrołajki", &icu_locale::langid!("pl-PL")),
            "futrolajki"
        );

        assert_eq!(
            slugify_for_label("Örli Försztivál", &icu_locale::langid!("hu-HU")),
            "orli-forsztival"
        );

        assert_eq!(
            slugify_for_label("んなモフ", &icu_locale::langid!("ja-JP")),
            "nnamohu"
        );

        assert_eq!(
            slugify_for_label("Fur-Eh!", &icu_locale::langid!("en-CA")),
            "fur-eh"
        );
    }
}
