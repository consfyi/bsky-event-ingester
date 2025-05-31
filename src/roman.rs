pub fn to_roman(mut num: u32) -> String {
    if num == 0 {
        return "N".to_string();
    }

    const SYMBOLS: &[(u32, &str)] = &[
        (1000, "M"),
        (900, "CM"),
        (500, "D"),
        (400, "CD"),
        (100, "C"),
        (90, "XC"),
        (50, "L"),
        (40, "XL"),
        (10, "X"),
        (9, "IX"),
        (5, "V"),
        (4, "IV"),
        (1, "I"),
    ];

    let mut result = String::new();

    for (value, symbol) in SYMBOLS.iter() {
        while num >= *value {
            result.push_str(symbol);
            num -= value;
        }
    }

    result
}

pub fn from_roman(s: &str) -> Option<u32> {
    if s.eq_ignore_ascii_case("N") {
        return Some(0);
    }

    const fn symbol_to_int(c: char) -> Option<u32> {
        Some(match c.to_ascii_uppercase() {
            'I' => 1,
            'V' => 5,
            'X' => 10,
            'L' => 50,
            'C' => 100,
            'D' => 500,
            'M' => 1000,
            _ => {
                return None;
            }
        })
    }

    let chars: Vec<char> = s.chars().collect();
    let mut total = 0;
    let mut i = 0;

    while i < chars.len() {
        let current = symbol_to_int(chars[i])?;

        let next = if i + 1 < chars.len() {
            symbol_to_int(chars[i + 1])?
        } else {
            0
        };

        if next > current {
            total += next - current;
            i += 2;
        } else {
            total += current;
            i += 1;
        }
    }

    Some(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_to_roman_zero_and_small_numbers() {
        assert_eq!(to_roman(0), "N");
        assert_eq!(to_roman(1), "I");
        assert_eq!(to_roman(4), "IV");
        assert_eq!(to_roman(5), "V");
        assert_eq!(to_roman(9), "IX");
        assert_eq!(to_roman(10), "X");
    }

    #[test]
    fn test_to_roman_medium_numbers() {
        assert_eq!(to_roman(40), "XL");
        assert_eq!(to_roman(44), "XLIV");
        assert_eq!(to_roman(58), "LVIII");
        assert_eq!(to_roman(90), "XC");
        assert_eq!(to_roman(94), "XCIV");
    }

    #[test]
    fn test_to_roman_large_numbers() {
        assert_eq!(to_roman(100), "C");
        assert_eq!(to_roman(400), "CD");
        assert_eq!(to_roman(500), "D");
        assert_eq!(to_roman(900), "CM");
        assert_eq!(to_roman(944), "CMXLIV");
        assert_eq!(to_roman(1000), "M");
        assert_eq!(to_roman(1994), "MCMXCIV");
        assert_eq!(to_roman(3999), "MMMCMXCIX");
    }

    #[test]
    fn test_from_roman_zero_and_simple() {
        assert_eq!(from_roman("N"), Some(0));
        assert_eq!(from_roman("n"), Some(0));
        assert_eq!(from_roman("I"), Some(1));
        assert_eq!(from_roman("i"), Some(1));
        assert_eq!(from_roman("V"), Some(5));
        assert_eq!(from_roman("X"), Some(10));
        assert_eq!(from_roman("L"), Some(50));
        assert_eq!(from_roman("C"), Some(100));
        assert_eq!(from_roman("D"), Some(500));
        assert_eq!(from_roman("M"), Some(1000));
    }

    #[test]
    fn test_from_roman_subtractive() {
        assert_eq!(from_roman("IV"), Some(4));
        assert_eq!(from_roman("IX"), Some(9));
        assert_eq!(from_roman("XL"), Some(40));
        assert_eq!(from_roman("XC"), Some(90));
        assert_eq!(from_roman("CD"), Some(400));
        assert_eq!(from_roman("CM"), Some(900));
    }

    #[test]
    fn test_from_roman_additive() {
        assert_eq!(from_roman("LVIII"), Some(58));
        assert_eq!(from_roman("XCIV"), Some(94));
        assert_eq!(from_roman("CMXLIV"), Some(944));
        assert_eq!(from_roman("MCMXCIV"), Some(1994));
        assert_eq!(from_roman("MMMCMXCIX"), Some(3999));
    }

    #[test]
    fn test_from_roman_lowercase_input() {
        assert_eq!(from_roman("iv"), Some(4));
        assert_eq!(from_roman("mcmxciv"), Some(1994));
        assert_eq!(from_roman("mmmdccclxxxviii"), Some(3888));
    }

    #[test]
    fn test_from_roman_invalid_symbols() {
        assert_eq!(from_roman("A"), None);
        assert_eq!(from_roman("ABCD"), None);
        assert_eq!(from_roman("IQ"), None);
        assert_eq!(from_roman("q"), None);
    }

    #[test]
    fn test_round_trip_small_numbers() {
        for n in 0..20 {
            assert_eq!(from_roman(&to_roman(n)), Some(n));
        }
    }

    #[test]
    fn test_round_trip() {
        for n in [
            3, 8, 14, 27, 44, 59, 73, 88, 99, 142, 199, 242, 388, 499, 501, 688, 944, 1001, 2025,
            3050, 3888, 3999, 4444, 5000,
        ] {
            assert_eq!(from_roman(&to_roman(n)), Some(n));
        }
    }
}
