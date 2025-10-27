pub mod event;

pub const ZSTD_DICTIONARY: std::sync::LazyLock<zstd::dict::DecoderDictionary<'static>> =
    std::sync::LazyLock::new(|| {
        zstd::dict::DecoderDictionary::copy(include_bytes!("./zstd_dictionary"))
    });
