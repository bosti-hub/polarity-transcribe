//! Word lists for hesitation fillers and listener backchannels.

use crate::asr::Language;

/// Strip surrounding punctuation and lower-case a word for lexicon lookups.
pub fn normalize(word: &str) -> String {
    word.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase()
}

const FILLERS_COMMON: &[&str] = &[
    "uh", "uhh", "uhm", "uhmm", "um", "umm", "eh", "ehh", "ehm", "hm", "hmm", "hmmm", "mm", "mmm",
    "mhm", "mmhm", "mm-hm", "mm-hmm", "hm-hm", "uh-huh", "ah", "ahh", "ahm",
];
const FILLERS_NL: &[&str] = &["euh", "euhm", "eeh", "ehhm", "uhu", "uhuh"];
const FILLERS_EN: &[&str] = &["er", "erm", "uhuh", "huh"];

/// Hesitation sounds that are put in brackets in the transcript.
pub fn is_filler(word: &str, lang: Language) -> bool {
    let w = normalize(word);
    if w.is_empty() {
        return false;
    }
    FILLERS_COMMON.contains(&w.as_str())
        || match lang {
            Language::Nl => FILLERS_NL.contains(&w.as_str()),
            Language::En => FILLERS_EN.contains(&w.as_str()),
        }
}

const BACKCHANNEL_NL: &[&str] = &[
    "ja", "jaja", "jawel", "nee", "neenee", "oké", "oke", "ok", "okay", "precies", "juist",
    "inderdaad", "zeker", "klopt", "oh", "ah", "aha", "goed", "mooi", "tuurlijk", "natuurlijk",
    "snap", "ik", "echt", "nou", "zo", "hè", "he", "top", "helder", "duidelijk",
];
const BACKCHANNEL_EN: &[&str] = &[
    "yeah", "yes", "yep", "yup", "no", "nope", "right", "okay", "ok", "sure", "exactly", "oh",
    "ah", "aha", "wow", "really", "true", "totally", "absolutely", "i", "see", "got", "it",
    "cool", "nice", "indeed", "of", "course",
];

/// Whether every word of a short utterance is a listening sound ("ja", "hm-hm", "right").
pub fn is_backchannel(words: &[&str], lang: Language) -> bool {
    if words.is_empty() || words.len() > 3 {
        return false;
    }
    let list = match lang {
        Language::Nl => BACKCHANNEL_NL,
        Language::En => BACKCHANNEL_EN,
    };
    let mut any_core = false;
    for w in words {
        let n = normalize(w);
        if n.is_empty() {
            continue;
        }
        if is_filler(&n, lang) || list.contains(&n.as_str()) {
            any_core = true;
        } else {
            return false;
        }
    }
    any_core
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fillers() {
        assert!(is_filler("Uhm,", Language::Nl));
        assert!(is_filler("hmm...", Language::En));
        assert!(is_filler("euh", Language::Nl));
        assert!(!is_filler("euh", Language::En));
        assert!(!is_filler("ja", Language::Nl));
    }

    #[test]
    fn backchannels() {
        assert!(is_backchannel(&["Ja,", "ja."], Language::Nl));
        assert!(is_backchannel(&["Hm-hm."], Language::Nl));
        assert!(is_backchannel(&["Right."], Language::En));
        assert!(!is_backchannel(&["Ja,", "maar", "dat"], Language::Nl));
        assert!(!is_backchannel(&["ja", "ja", "ja", "ja"], Language::Nl));
    }
}
