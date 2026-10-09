//! 5-field cron expressions (minute hour day-of-month month day-of-week),
//! evaluated in local time — mirrors `tools/cron/cron-expr.ts`.

use chrono::{DateTime, Datelike, Duration, Local, Timelike};

/// A parsed cron expression.
#[derive(Debug, Clone)]
pub struct CronExpression {
    minutes: FieldSet,
    hours: FieldSet,
    days: FieldSet,
    months: FieldSet,
    weekdays: FieldSet,
}

/// One field: a bitmap over its range plus whether it was `*`.
#[derive(Debug, Clone)]
struct FieldSet {
    values: Vec<bool>,
    any: bool,
}

impl FieldSet {
    fn matches(&self, value: u32) -> bool {
        self.values.get(value as usize).copied().unwrap_or(false)
    }
}

/// Parse error for an invalid expression.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronParseError(pub String);

impl std::fmt::Display for CronParseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "invalid cron expression: {}", self.0)
    }
}

impl std::error::Error for CronParseError {}

impl CronExpression {
    /// Parse a standard 5-field expression.
    pub fn parse(expression: &str) -> Result<Self, CronParseError> {
        let fields: Vec<&str> = expression.split_whitespace().collect();
        if fields.len() != 5 {
            return Err(CronParseError(format!(
                "expected 5 fields (minute hour day-of-month month day-of-week), got {}",
                fields.len()
            )));
        }
        Ok(Self {
            minutes: parse_field(fields[0], 0, 59)?,
            hours: parse_field(fields[1], 0, 23)?,
            days: parse_field(fields[2], 1, 31)?,
            months: parse_field(fields[3], 1, 12)?,
            weekdays: parse_weekdays(fields[4])?,
        })
    }

    /// Whether the expression fires at the given local time (minute
    /// resolution; seconds are ignored).
    pub fn matches(&self, time: &DateTime<Local>) -> bool {
        if !self.minutes.matches(time.minute()) || !self.hours.matches(time.hour()) {
            return false;
        }
        if !self.months.matches(time.month()) {
            return false;
        }
        let day_of_month = self.days.matches(time.day());
        // chrono: Monday = 0 .. Sunday = 6; cron: Sunday = 0 .. Saturday = 6.
        let weekday = time.weekday().num_days_from_sunday();
        let day_of_week = self.weekdays.matches(weekday);
        // Standard cron semantics: when both day fields are restricted they
        // combine with OR, otherwise with AND.
        if self.days.any && self.weekdays.any {
            true
        } else if self.days.any {
            day_of_week
        } else if self.weekdays.any {
            day_of_month
        } else {
            day_of_month || day_of_week
        }
    }

    /// The first matching local time strictly after `from` (minute
    /// resolution). Searches up to one year ahead.
    pub fn next_after(&self, from: &DateTime<Local>) -> Option<DateTime<Local>> {
        // Start at the next whole minute.
        let mut candidate = (*from + Duration::minutes(1))
            .with_second(0)?
            .with_nanosecond(0)?;
        let horizon = *from + Duration::days(366);
        while candidate <= horizon {
            if self.matches(&candidate) {
                return Some(candidate);
            }
            candidate += Duration::minutes(1);
        }
        None
    }
}

fn parse_weekdays(field: &str) -> Result<FieldSet, CronParseError> {
    let mut set = parse_field(field, 0, 7)?;
    // 7 is an alias for Sunday (0).
    if set.values.get(7).copied().unwrap_or(false) {
        set.values[0] = true;
    }
    set.values.truncate(7);
    Ok(set)
}

fn parse_field(field: &str, min: u32, max: u32) -> Result<FieldSet, CronParseError> {
    let any = field == "*";
    let mut values = vec![false; (max + 1) as usize];
    for part in field.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((range, step)) => {
                let step: u32 = step
                    .parse()
                    .map_err(|_| CronParseError(format!("bad step in `{part}`")))?;
                if step == 0 {
                    return Err(CronParseError(format!("zero step in `{part}`")));
                }
                (range, step)
            }
            None => (part, 1),
        };
        let (start, end) = if range == "*" {
            (min, max)
        } else if let Some((start, end)) = range.split_once('-') {
            let start: u32 = start
                .parse()
                .map_err(|_| CronParseError(format!("bad range start in `{part}`")))?;
            let end: u32 = end
                .parse()
                .map_err(|_| CronParseError(format!("bad range end in `{part}`")))?;
            (start, end)
        } else {
            let value: u32 = range
                .parse()
                .map_err(|_| CronParseError(format!("bad value in `{part}`")))?;
            (value, value)
        };
        if start < min || end > max || start > end {
            return Err(CronParseError(format!("`{part}` out of range {min}-{max}")));
        }
        let mut value = start;
        while value <= end {
            values[value as usize] = true;
            value += step;
        }
    }
    Ok(FieldSet { values, any })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn local(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(y, mo, d, h, mi, 0)
            .single()
            .expect("valid local time")
    }

    #[test]
    fn parses_and_rejects_bad_expressions() {
        assert!(CronExpression::parse("*/5 * * * *").is_ok());
        assert!(CronExpression::parse("0 9 * * 1-5").is_ok());
        assert!(CronExpression::parse("3 9 15 6 *").is_ok());
        assert!(CronExpression::parse("bad").is_err());
        assert!(CronExpression::parse("60 * * * *").is_err());
        assert!(CronExpression::parse("* 24 * * *").is_err());
        assert!(CronExpression::parse("*/0 * * * *").is_err());
        assert!(CronExpression::parse("* * 0 * *").is_err());
        assert!(CronExpression::parse("* * * 13 *").is_err());
    }

    #[test]
    fn matches_minute_hour_and_month() {
        let expr = CronExpression::parse("30 14 * * *").unwrap();
        assert!(expr.matches(&local(2026, 10, 8, 14, 30)));
        assert!(!expr.matches(&local(2026, 10, 8, 14, 31)));
        assert!(!expr.matches(&local(2026, 10, 8, 15, 30)));
    }

    #[test]
    fn weekday_ranges_use_cron_numbering() {
        // Weekdays at 9:05 — 2026-10-08 is a Thursday.
        let expr = CronExpression::parse("5 9 * * 1-5").unwrap();
        assert!(expr.matches(&local(2026, 10, 8, 9, 5)));
        // 2026-10-10 is a Saturday.
        assert!(!expr.matches(&local(2026, 10, 10, 9, 5)));
        // Sunday can be 0 or 7.
        let sunday = CronExpression::parse("5 9 * * 7").unwrap();
        assert!(sunday.matches(&local(2026, 10, 11, 9, 5)));
    }

    #[test]
    fn day_fields_combine_with_or_when_restricted() {
        // Both day-of-month and day-of-week restricted → OR.
        let expr = CronExpression::parse("0 0 15 * 5").unwrap();
        assert!(expr.matches(&local(2026, 10, 15, 0, 0))); // 15th (a Thursday)
        assert!(expr.matches(&local(2026, 10, 9, 0, 0))); // a Friday
        assert!(!expr.matches(&local(2026, 10, 8, 0, 0))); // Thursday, not 15th
    }

    #[test]
    fn next_after_advances_to_the_next_match() {
        let expr = CronExpression::parse("*/5 * * * *").unwrap();
        let from = local(2026, 10, 8, 10, 2);
        let next = expr.next_after(&from).unwrap();
        assert_eq!((next.hour(), next.minute()), (10, 5));

        // Steps to the next day when the hour has passed.
        let daily = CronExpression::parse("57 8 * * *").unwrap();
        let from = local(2026, 10, 8, 10, 0);
        let next = daily.next_after(&from).unwrap();
        assert_eq!((next.day(), next.hour(), next.minute()), (9, 8, 57));
    }
}
