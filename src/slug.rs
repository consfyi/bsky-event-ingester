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
    T::Owned: AsRef<T> + 'a,
{
    match input {
        std::borrow::Cow::Borrowed(b) => f(b),
        std::borrow::Cow::Owned(o) => std::borrow::Cow::Owned(f(o.as_ref()).into_owned()),
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
