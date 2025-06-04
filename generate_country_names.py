import requests
import json

print(
    """\
static COUNTRIES: std::sync::LazyLock<std::collections::HashMap<&'static str, &'static str>> =
    std::sync::LazyLock::new(|| {
        std::collections::HashMap::from([\
"""
)
for country in requests.get(
    "https://restcountries.com/v3.1/all?fields=name,altSpellings,cca2"
).json():
    cca2 = country["cca2"]
    for name in sorted(
        set(
            [
                country["name"]["common"],
                country["name"]["official"],
                *country["altSpellings"],
            ]
        )
    ):
        print(f'            ({json.dumps(name, ensure_ascii=False)}, "{cca2}"),')
print(
    """\
        ])
    });

pub fn find(name: &str) -> Option<&'static str> {
    COUNTRIES.get(name).cloned()
}\
"""
)
