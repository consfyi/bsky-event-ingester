pub fn guess_language_for_region(
    region: icu_locale::subtags::Region,
) -> icu_locale::LanguageIdentifier {
    const LOCALE_EXPANDER: icu_locale::LocaleExpander = icu_locale::LocaleExpander::new_common();
    let mut langid = icu_locale::LanguageIdentifier::UNKNOWN;
    langid.region = Some(region);
    LOCALE_EXPANDER.maximize(&mut langid);
    langid
}

pub fn slugify(s: &str, langid: &icu_locale::LanguageIdentifier) -> String {
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"[^\p{L}\p{N}\s-]+").unwrap());
    const CASE_MAPPER: icu_casemap::CaseMapperBorrowed<'static> = icu_casemap::CaseMapper::new();
    const NORMALIZER: icu_normalizer::ComposingNormalizerBorrowed<'static> =
        icu_normalizer::ComposingNormalizer::new_nfkc();

    CASE_MAPPER
        .lowercase_to_string(&RE.replace_all(&NORMALIZER.normalize(s), ""), langid)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
}
