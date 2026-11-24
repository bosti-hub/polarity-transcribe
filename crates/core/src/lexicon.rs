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

/// Fillers a listener makes ("hm-hm", "uh-huh"), as opposed to the hesitations of whoever is
/// talking ("uhm", "eh").
const LISTENING_FILLERS: &[&str] =
    &["hm", "hmm", "hmmm", "mm", "mmm", "mhm", "mmhm", "mm-hm", "mm-hmm", "hm-hm", "uh-huh", "uhuh", "ah", "ahh"];

/// A hesitation of the speaker ("uhm", "eh", "euh"): a filler that is not a listening sound.
pub fn is_hesitation(word: &str, lang: Language) -> bool {
    is_filler(word, lang) && !LISTENING_FILLERS.contains(&normalize(word).as_str())
}

// Listening sounds and short reactions of a listener: agreement ("klopt", "exactly"), taking
// note ("o ja", "I see"), understanding ("dat snap ik", "makes sense"), surprise ("echt?",
// "no way") and short evaluations ("wat erg", "that's tough"). Only whole utterances made of
// these count; anything with a word of its own ("ja, maar…") stays a turn. Words that often
// open a real turn ("en", "dus", "maar", "so", "and", "but") are left out on purpose.

const BACKCHANNEL_NL: &[&str] = &[
    // yes, no, okay
    "ja", "jaa", "jah", "jaja", "jawel", "jep", "nee", "neenee", "neuh", "oké", "oke", "ok", "okay",
    // agreement and understanding
    "precies", "exact", "juist", "inderdaad", "zeker", "absoluut", "uiteraard", "natuurlijk",
    "tuurlijk", "klopt", "eens", "snap", "logisch", "begrijpelijk", "helder", "duidelijk",
    "helemaal",
    // interjections and surprise
    "oh", "o", "ah", "aha", "ach", "oei", "oeh", "goh", "jee", "jeetje", "jemig", "tjonge",
    "tjongejonge", "sjonge", "wauw", "wow", "nou", "zo", "zozo", "hè", "he", "joh", "tja", "tsja",
    "echt", "serieus",
    // short evaluations
    "goed", "mooi", "fijn", "prima", "top", "leuk", "gaaf", "tof", "super", "interessant",
    "grappig", "apart", "bijzonder", "gek", "raar", "bizar", "heftig", "pittig", "lastig", "zwaar",
    "jammer", "sneu", "vervelend", "verschrikkelijk", "vreselijk",
];
const BACKCHANNEL_EN: &[&str] = &[
    // yes, no, okay
    "yeah", "yes", "yep", "yup", "yah", "ya", "no", "nope", "nah", "okay", "ok", "kay", "alright",
    "right", "sure", "see", "si", "sí",
    // agreement and understanding
    "exactly", "precisely", "absolutely", "totally", "definitely", "certainly", "indeed", "true",
    "correct", "agreed", "fair", "gotcha",
    // interjections and surprise
    "oh", "ah", "aha", "ahh", "ooh", "whoa", "woah", "wow", "gosh", "jeez", "geez", "damn",
    "yikes", "ouch", "oops", "really", "seriously",
    // short evaluations
    "good", "great", "nice", "cool", "fine", "perfect", "awesome", "amazing", "wonderful",
    "lovely", "brilliant", "excellent", "interesting", "fascinating", "funny", "crazy", "wild",
    "weird", "sad", "tough", "awful", "terrible", "horrible",
];

/// Short reactions of more than one word, each counted as one listening sound.
const PHRASES_NL: &[&str] = &[
    // taking note, surprise
    "o ja", "oh ja", "ah ja", "a ja", "o nee", "oh nee", "o jee", "oh jee", "o god", "oh god",
    "mijn god", "o wauw", "oh wauw", "ah zo", "o zo", "oh zo", "o kijk", "oh kijk", "nou nou",
    "nou ja", "echt waar", "meen je dat", "meen je niet", "nee joh", "ja joh", "ja hoor",
    "zeker weten",
    // understanding and agreement
    "dat snap ik", "snap ik", "ik snap het", "ik snap", "dat begrijp ik", "begrijp ik",
    "ik begrijp het", "dat kan ik me voorstellen", "kan ik me voorstellen", "dat geloof ik",
    "geloof ik", "dat klopt", "dat is waar", "is waar", "dat is zo", "ik weet het", "weet ik",
    "dat weet ik", "ik ook", "mee eens", "helemaal mee eens", "je hebt gelijk", "gelijk heb je",
    // short evaluations
    "is goed", "dat is goed", "goed zo", "mooi zo", "helemaal goed", "dat is mooi",
    "dat is fijn", "dat is leuk", "dat is interessant", "dat is grappig", "dat is bijzonder",
    "dat is lastig", "dat is jammer", "dat is vervelend", "dat is heftig", "dat is erg",
    "wat erg", "wat naar", "wat rot", "wat vervelend", "wat jammer", "wat heftig", "wat goed",
    "wat mooi", "wat leuk", "wat fijn", "wat interessant", "wat bijzonder", "wat grappig",
    "wat apart", "wat raar", "wat gek",
];
const PHRASES_EN: &[&str] = &[
    // taking note, surprise
    "i see", "oh i see", "no way", "oh no", "oh my god", "oh my gosh", "my god", "my gosh",
    "oh dear", "oh my", "oh wow", "oh okay", "oh really", "go on",
    // understanding and agreement
    "i know", "i bet", "i agree", "i get it", "i get that", "i hear you", "i understand",
    "i can imagine", "can imagine", "i guess", "i guess so", "makes sense", "that makes sense",
    "fair enough", "of course", "for sure", "got it", "got you", "all right", "you're right",
    "good point", "me too", "me neither", "same here", "same", "so true", "can be", "could be",
    "that's true", "that's right", "that's fair", "that's so true",
    // short evaluations
    "good for you", "good to know", "sounds good", "sounds great", "sounds fun", "sounds hard",
    "sounds tough", "that's interesting", "that's fascinating", "that's nice", "that's great",
    "that's good", "that's cool", "that's amazing", "that's awesome", "that's wonderful",
    "that's crazy", "that's wild", "that's insane", "that's funny", "that's sad", "that's tough",
    "that's hard", "that's awful", "that's terrible", "that's horrible", "that's rough",
    "that's okay", "it's okay", "how interesting", "how nice", "how sad",
];

/// Whether a short utterance is only listening sounds ("ja", "hm-hm", "right") and short
/// reactions ("I can imagine", "dat snap ik", "wat erg"): at most three of them, each a word or
/// a phrase from the list. Hesitations ("eh") do not count, and a repeat ("ja ja ja ja",
/// "right, right") counts once.
pub fn is_backchannel(words: &[&str], lang: Language) -> bool {
    if words.is_empty() || words.len() > 7 {
        return false;
    }
    let (list, phrases) = match lang {
        Language::Nl => (BACKCHANNEL_NL, PHRASES_NL),
        Language::En => (BACKCHANNEL_EN, PHRASES_EN),
    };
    let tokens: Vec<String> = words.iter().map(|w| normalize(&w.replace('’', "'"))).filter(|n| !n.is_empty()).collect();
    let mut units = 0usize;
    let mut last: &[String] = &[];
    let mut i = 0usize;
    while i < tokens.len() {
        // The longest phrase that starts here, else a single listening word.
        let phrase = phrases
            .iter()
            .map(|p| p.split(' ').collect::<Vec<_>>())
            .filter(|p| p.len() <= tokens.len() - i && p.iter().zip(&tokens[i..]).all(|(a, b)| *a == b))
            .map(|p| p.len())
            .max();
        let len = match phrase {
            Some(len) => len,
            None if is_filler(&tokens[i], lang) => {
                i += 1;
                continue;
            }
            None if list.contains(&tokens[i].as_str()) => 1,
            None => return false,
        };
        let unit = &tokens[i..i + len];
        if unit != last {
            units += 1;
        }
        last = unit;
        i += len;
    }
    // Only hesitations ("hm-hm") is a listening sound as well.
    !tokens.is_empty() && units <= 3
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
        assert!(!is_backchannel(&["...", "?"], Language::Nl));
        // Four different reactions in a row are more than a listening sound.
        assert!(!is_backchannel(&["ja", "nee", "precies", "klopt"], Language::Nl));
    }

    #[test]
    fn repeats_and_hesitations_count_once() {
        assert!(is_backchannel(&["ja", "ja", "ja", "ja"], Language::Nl));
        assert!(is_backchannel(&["Nee,", "nee,", "nee."], Language::Nl));
        assert!(is_backchannel(&["Eh,", "ja,", "zeker,", "ja."], Language::Nl));
        assert!(is_backchannel(&["Right,", "right,", "right."], Language::En));
        assert!(is_backchannel(&["Yeah,", "yeah,", "yeah,", "good."], Language::En));
    }

    #[test]
    fn reactions_people_commonly_give() {
        for r in ["wat erg", "dat is heftig", "nee joh", "echt waar?", "ah zo", "o jee", "dat snap ik, ja", "goh, interessant"] {
            assert!(is_backchannel(&r.split(' ').collect::<Vec<_>>(), Language::Nl), "{r}");
        }
        for r in ["Oh my god.", "No way!", "That's tough.", "That’s crazy.", "I hear you.", "Sounds good.", "Oh, I see.", "Right, makes sense."] {
            assert!(is_backchannel(&r.split(' ').collect::<Vec<_>>(), Language::En), "{r}");
        }
        // A word of its own makes it a turn.
        for r in ["wat erg voor je moeder", "ja, maar dat", "dus ja", "weet ik niet"] {
            assert!(!is_backchannel(&r.split(' ').collect::<Vec<_>>(), Language::Nl), "{r}");
        }
        for r in ["That's crazy, because I", "So yeah.", "And then?", "I guess not."] {
            assert!(!is_backchannel(&r.split(' ').collect::<Vec<_>>(), Language::En), "{r}");
        }
    }

    #[test]
    fn short_reactions() {
        assert!(is_backchannel(&["I", "can", "imagine,", "yeah."], Language::En));
        assert!(is_backchannel(&["Yeah,", "I", "can", "imagine."], Language::En));
        assert!(is_backchannel(&["Makes", "sense."], Language::En));
        assert!(is_backchannel(&["Good."], Language::En));
        assert!(is_backchannel(&["Can", "be,", "yeah."], Language::En));
        assert!(is_backchannel(&["Dat", "kan", "ik", "me", "voorstellen."], Language::Nl));
        assert!(is_backchannel(&["O", "ja,", "interessant."], Language::Nl));
        assert!(!is_backchannel(&["I", "study", "European"], Language::En));
        assert!(!is_backchannel(&["Makes", "sense,", "but", "why?"], Language::En));
    }
}
