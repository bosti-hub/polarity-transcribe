//! The transcript document: what the editor shows, what exports are made from.
//!
//! Mirrors `src/lib/types.ts`.

use crate::asr::Language;
use serde::{Deserialize, Serialize};

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "k")]
pub enum Item {
    /// A word. `t` includes attached punctuation; fillers are stored bracketed ("[uhm],").
    #[serde(rename = "w")]
    Word {
        t: String,
        s: f64,
        e: f64,
        /// Recogniser confidence, 0..1.
        c: f32,
        #[serde(default, skip_serializing_if = "is_false")]
        f: bool,
    },
    /// A measured silence.
    #[serde(rename = "p")]
    Pause { s: f64, e: f64 },
    /// A short listening sound by another speaker, shown inline.
    #[serde(rename = "b")]
    Backchannel { sp: String, t: String, s: f64, e: f64 },
    /// A behavioural note such as "[lacht]".
    #[serde(rename = "n")]
    Note {
        t: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        s: Option<f64>,
    },
}

impl Item {
    pub fn start(&self) -> Option<f64> {
        match self {
            Item::Word { s, .. } | Item::Pause { s, .. } | Item::Backchannel { s, .. } => Some(*s),
            Item::Note { s, .. } => *s,
        }
    }
    pub fn end(&self) -> Option<f64> {
        match self {
            Item::Word { e, .. } | Item::Pause { e, .. } | Item::Backchannel { e, .. } => Some(*e),
            Item::Note { s, .. } => *s,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Paragraph {
    pub id: String,
    pub speaker: String,
    pub start: f64,
    pub end: f64,
    pub items: Vec<Item>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Speaker {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Transcript {
    pub version: u32,
    pub language: Language,
    pub duration: f64,
    pub speakers: Vec<Speaker>,
    pub paragraphs: Vec<Paragraph>,
}

pub fn speaker_id(index: usize) -> String {
    format!("S{}", index + 1)
}

pub fn default_speaker_name(index: usize, lang: Language) -> String {
    match lang {
        Language::Nl => format!("Spreker {}", index + 1),
        Language::En => format!("Speaker {}", index + 1),
    }
}

/// Name the two speakers of an interview by role: whoever asks the questions is the interviewer.
///
/// Measured per speaker: the share of their sentences that end in a question mark, and how
/// much of the talking they do. The interviewer asks clearly more questions and usually talks
/// less. Returns false (and changes nothing) unless there are exactly two speakers and the
/// difference is clear.
pub fn name_by_role(t: &mut Transcript, interviewer: &str, respondent: &str) -> bool {
    if t.speakers.len() != 2 || interviewer.trim().is_empty() || respondent.trim().is_empty() {
        return false;
    }
    // (questions, sentences, words) per speaker.
    let mut stats = [(0usize, 0usize, 0usize); 2];
    for p in &t.paragraphs {
        let Some(k) = t.speakers.iter().position(|s| s.id == p.speaker) else { continue };
        for item in &p.items {
            if let Item::Word { t: text, f, .. } = item {
                if *f {
                    continue;
                }
                stats[k].2 += 1;
                let text = text.trim_end_matches(['"', '\'', ')']);
                if text.ends_with('?') {
                    stats[k].0 += 1;
                    stats[k].1 += 1;
                } else if text.ends_with(['.', '!']) {
                    stats[k].1 += 1;
                }
            }
        }
    }
    let rate = |k: usize| stats[k].0 as f64 / stats[k].1.max(1) as f64;
    let (a, b) = (rate(0), rate(1));
    let asker = if a > b { 0 } else { 1 };
    let other = 1 - asker;
    // Clear evidence only: enough questions, a real difference in question rate, and the
    // asker does not do most of the talking.
    let clear = stats[asker].0 >= 3 && rate(asker) >= 2.0 * rate(other) && rate(asker) - rate(other) >= 0.1;
    let talks_less = stats[asker].2 <= stats[other].2 * 3 / 2;
    if !clear || !talks_less {
        return false;
    }
    t.speakers[asker].name = interviewer.trim().to_string();
    t.speakers[other].name = respondent.trim().to_string();
    true
}

/// Round a time to milliseconds (keeps the JSON compact and stable).
pub fn ms(t: f64) -> f64 {
    (t * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(speaker: &str, text: &str) -> Paragraph {
        let items = text
            .split_whitespace()
            .map(|w| Item::Word { t: w.into(), s: 0.0, e: 0.0, c: 1.0, f: w.starts_with('[') })
            .collect();
        Paragraph { id: String::new(), speaker: speaker.into(), start: 0.0, end: 0.0, items }
    }

    fn transcript(paragraphs: Vec<Paragraph>) -> Transcript {
        Transcript {
            version: 1,
            language: Language::Nl,
            duration: 0.0,
            speakers: vec![Speaker { id: "S1".into(), name: "Spreker 1".into() }, Speaker { id: "S2".into(), name: "Spreker 2".into() }],
            paragraphs,
        }
    }

    #[test]
    fn the_one_who_asks_is_the_interviewer() {
        let answer = "Nou, [eh], dat was best lastig. Ik werkte toen nog op de afdeling. Het ging niet goed.";
        let mut t = transcript(vec![
            turn("S2", "Welkom. Hoe gaat het met je?"),
            turn("S1", answer),
            turn("S2", "Kun je daar meer over vertellen?"),
            turn("S1", answer),
            turn("S2", "En wat deed je toen?"),
            turn("S1", answer),
        ]);
        assert!(name_by_role(&mut t, "Interviewer", "R03"));
        assert_eq!(t.speakers[1].name, "Interviewer");
        assert_eq!(t.speakers[0].name, "R03");
    }

    #[test]
    fn no_names_without_clear_evidence() {
        let mut t = transcript(vec![turn("S1", "Wat vind jij? Ik weet het niet."), turn("S2", "Geen idee? Ik ook niet.")]);
        assert!(!name_by_role(&mut t, "Interviewer", "R01"));
        assert_eq!(t.speakers[0].name, "Spreker 1");
    }
}
