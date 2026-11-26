'use strict';

/**
 * Check if `vhost` is a valid suffix of `hostname` (top-domain)
 *
 * It means that `vhost` needs to be a suffix of `hostname` and we then need to
 * make sure that: either they are equal, or the character preceding `vhost` in
 * `hostname` is a '.' (it should not be a partial label).
 *
 * * hostname = 'not.evil.com' and vhost = 'vil.com'      => not ok
 * * hostname = 'not.evil.com' and vhost = 'evil.com'     => ok
 * * hostname = 'not.evil.com' and vhost = 'not.evil.com' => ok
 */
function shareSameDomainSuffix(hostname, vhost) {
    if (hostname.endsWith(vhost)) {
        return (hostname.length === vhost.length ||
            hostname[hostname.length - vhost.length - 1] === '.');
    }
    return false;
}
/**
 * Given a hostname and its public suffix, extract the general domain.
 */
function extractDomainWithSuffix(hostname, publicSuffix) {
    // Locate the index of the last '.' in the part of the `hostname` preceding
    // the public suffix.
    //
    // examples:
    //   1. not.evil.co.uk  => evil.co.uk
    //         ^    ^
    //         |    | start of public suffix
    //         | index of the last dot
    //
    //   2. example.co.uk   => example.co.uk
    //     ^       ^
    //     |       | start of public suffix
    //     |
    //     | (-1) no dot found before the public suffix
    const publicSuffixIndex = hostname.length - publicSuffix.length - 2;
    const lastDotBeforeSuffixIndex = hostname.lastIndexOf('.', publicSuffixIndex);
    // No '.' found, then `hostname` is the general domain (no sub-domain)
    if (lastDotBeforeSuffixIndex === -1) {
        return hostname;
    }
    // Extract the part between the last '.'
    return hostname.slice(lastDotBeforeSuffixIndex + 1);
}
/**
 * Detects the domain based on rules and upon and a host string
 */
function getDomain(suffix, hostname, options) {
    // Check if `hostname` ends with a member of `validHosts`.
    if (options.validHosts !== null) {
        const validHosts = options.validHosts;
        for (const vhost of validHosts) {
            if ( /*@__INLINE__*/shareSameDomainSuffix(hostname, vhost)) {
                return vhost;
            }
        }
    }
    let numberOfLeadingDots = 0;
    if (hostname.startsWith('.')) {
        while (numberOfLeadingDots < hostname.length &&
            hostname[numberOfLeadingDots] === '.') {
            numberOfLeadingDots += 1;
        }
    }
    // If `hostname` is a valid public suffix, then there is no domain to return.
    // Since we already know that `getPublicSuffix` returns a suffix of `hostname`
    // there is no need to perform a string comparison and we only compare the
    // size.
    if (suffix.length === hostname.length - numberOfLeadingDots) {
        return null;
    }
    // To extract the general domain, we start by identifying the public suffix
    // (if any), then consider the domain to be the public suffix with one added
    // level of depth. (e.g.: if hostname is `not.evil.co.uk` and public suffix:
    // `co.uk`, then we take one more level: `evil`, giving the final result:
    // `evil.co.uk`).
    return /*@__INLINE__*/ extractDomainWithSuffix(hostname, suffix);
}

/**
 * Return the part of domain without suffix.
 *
 * Example: for domain 'foo.com', the result would be 'foo'.
 */
function getDomainWithoutSuffix(domain, suffix) {
    // Note: here `domain` and `suffix` cannot have the same length because in
    // this case we set `domain` to `null` instead. It is thus safe to assume
    // that `suffix` is shorter than `domain`.
    return domain.slice(0, -suffix.length - 1);
}

// `charCodeAt.call(url, i)`, not `url.charCodeAt(i)`: see `is-valid.ts`.
// eslint-disable-next-line @typescript-eslint/unbound-method
const charCodeAt$1 = String.prototype.charCodeAt;
/**
 * Matches an ASCII tab (U+0009) or newline (U+000A / U+000D). The WHATWG URL
 * parser strips these before parsing; we only allocate a cleaned copy (and
 * re-parse) on the rare input that actually contains one.
 */
const CONTROL_CHARS = /[\t\n\r]/g;
const HAS_CONTROL_CHAR = /[\t\n\r]/;
/**
 * Matches a forbidden domain code point
 * (https://url.spec.whatwg.org/#forbidden-domain-code-point): a C0 control,
 * space, '#', '%', '/', ':', '<', '>', '?', '@', '[', '\', ']', '^', '|' or DEL.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_DOMAIN_CHAR = /[\x00-\x20#%/:<>?@[\\\]^|\x7f]/;
// Set by `extractHostname` (a module-scope flag, read synchronously by
// `parseImpl` right after the call — same pattern as the reused RESULT object).
// `true` ONLY when extraction validated the returned host inline (a confirmed-
// valid, "simple" authority) so `parseImpl` can skip the separate
// `isValidHostname` pass. `false` in every other case (validation disabled, a
// complex authority — userinfo/port/brackets/trailing-dot/control — an invalid
// host, or a non-main return path); `parseImpl` then validates as usual. The
// fast path can only ever SKIP a redundant scan for hosts already known valid,
// never accept an invalid one.
let extractedHostnameValidated = false;
// Set by `extractHostname`, like `extractedHostnameValidated`: `true` ONLY when
// the returned host was in brackets ("http://[::1]/"). `parseImpl` then checks
// that it is an IPv6 address, as browsers do.
let extractedBracketedHost = false;
/**
 * True if char `code` is a valid hostname character. This is the per-char half
 * of `is-valid.ts`'s `isValidAscii` (a-z, 0-9, > U+007F) PLUS three additions:
 * A-Z (the host is lowercased before validation, so uppercase ≡ a valid
 * lowercase letter) and '-' / '_' (valid inside a label). KEEP IN SYNC with
 * `is-valid.ts`: these rules are deliberately duplicated to validate during
 * extraction, so any change to the accepted character set there must be
 * mirrored here (and vice-versa).
 */
function isValidHostnameChar(code) {
    return ((code >= 97 && code <= 122) || // a-z
        (code >= 48 && code <= 57) || // 0-9
        code > 127 || // non-ASCII (accepted, not punycode-checked)
        (code >= 65 && code <= 90) || // A-Z (becomes valid once lowercased)
        code === 45 || // '-'
        code === 95 // '_'
    );
}
/**
 * No hostname in `url`, unless a tab or newline, which browsers remove before
 * anything else, hides one ("sc:\t//host", "/\t/host"): `url` is then read
 * again without them. Only reached on inputs without a host.
 */
function noHostname(url, urlIsValidHostname, validate) {
    return HAS_CONTROL_CHAR.test(url)
        ? extractHostname(url.replace(CONTROL_CHARS, ''), urlIsValidHostname, validate)
        : null;
}
/**
 * True if char `code` may follow the first letter of a scheme: an ASCII letter,
 * a digit, '+', '-' or '.' (https://url.spec.whatwg.org/#scheme-state).
 */
function isSchemeChar(code) {
    return (((code | 32) >= 97 && (code | 32) <= 122) || // [a-zA-Z] (fold letters only)
        (code >= 48 && code <= 57) || // [0, 9]
        code === 46 || // '.'
        code === 45 || // '-'
        code === 43 // '+'
    );
}
/**
 * `hostname` percent-decoded as browsers decode the host of a special URL,
 * lower-cased and without trailing dots, or null where they find no valid host:
 * bytes that are no UTF-8 ("%FF"), a '%' not followed by two hexadecimal digits
 * ("%zz"), and characters forbidden in a domain once decoded ("%2F", "%3A",
 * "%5B::1%5D"). https://url.spec.whatwg.org/#concept-host-parser
 */
function decodeHostname(hostname) {
    let decoded;
    try {
        decoded = decodeURIComponent(hostname);
    }
    catch (_a) {
        return null;
    }
    if (FORBIDDEN_DOMAIN_CHAR.test(decoded)) {
        return null;
    }
    let end = decoded.length;
    while (end > 1 && charCodeAt$1.call(decoded, end - 1) === 46 /* '.' */) {
        end -= 1;
    }
    return decoded.slice(0, end).toLowerCase();
}
/**
 * True if `url.slice(start, end)` is a scheme, as browsers read one: an ASCII
 * letter, then scheme characters.
 */
function isScheme(url, start, end) {
    const first = charCodeAt$1.call(url, start) | 32;
    if (start === end || first < 97 || first > 122) {
        return false;
    }
    for (let i = start + 1; i < end; i += 1) {
        if (!isSchemeChar(charCodeAt$1.call(url, i))) {
            return false;
        }
    }
    return true;
}
/**
 * Classify scheme `url.slice(schemeStart, colonIndex)` as a WHATWG special
 * scheme without allocating a substring (case-insensitive via `| 32`).
 * Special schemes: ftp, file, http, https, ws, wss
 * (https://url.spec.whatwg.org/#special-scheme).
 *
 * @returns 0 = not special, 1 = special, 2 = file (its host sits only between
 *          "//" and the next slash).
 */
function getSpecialScheme(url, schemeStart, colonIndex) {
    const length = colonIndex - schemeStart;
    const c0 = charCodeAt$1.call(url, schemeStart) | 32;
    if (length === 2) {
        return c0 === 119 && (charCodeAt$1.call(url, schemeStart + 1) | 32) === 115
            ? 1
            : 0; // ws
    }
    else if (length === 3) {
        const c1 = charCodeAt$1.call(url, schemeStart + 1) | 32;
        const c2 = charCodeAt$1.call(url, schemeStart + 2) | 32;
        if (c0 === 119 && c1 === 115 && c2 === 115)
            return 1; // wss
        if (c0 === 102 && c1 === 116 && c2 === 112)
            return 1; // ftp
        return 0;
    }
    else if (length === 4) {
        const c1 = charCodeAt$1.call(url, schemeStart + 1) | 32;
        const c2 = charCodeAt$1.call(url, schemeStart + 2) | 32;
        const c3 = charCodeAt$1.call(url, schemeStart + 3) | 32;
        if (c0 === 104 && c1 === 116 && c2 === 116 && c3 === 112)
            return 1; // http
        if (c0 === 102 && c1 === 105 && c2 === 108 && c3 === 101)
            return 2; // file
        return 0;
    }
    else if (length === 5) {
        return c0 === 104 &&
            (charCodeAt$1.call(url, schemeStart + 1) | 32) === 116 &&
            (charCodeAt$1.call(url, schemeStart + 2) | 32) === 116 &&
            (charCodeAt$1.call(url, schemeStart + 3) | 32) === 112 &&
            (charCodeAt$1.call(url, schemeStart + 4) | 32) === 115
            ? 1
            : 0; // https
    }
    return 0;
}
/**
 * Extract a hostname from `url`, matching a WHATWG URL parser's host-boundary
 * behaviour (https://url.spec.whatwg.org/#concept-basic-url-parser) for tldts'
 * scope. It deliberately does NOT normalise the host (no IDNA/punycode or IPv4
 * canonicalisation; IPv6 brackets are stripped, not compressed), strips trailing
 * dots, and stays lenient where a strict parser rejects (bare host:port,
 * out-of-range port, user@host) — all documented deviations.
 *
 * @param urlIsValidHostname - when true, `url` is already a valid hostname and is
 *   returned by the same reference (factory.ts skips re-validation on that
 *   identity), keeping the common path allocation-free.
 * @param validate - when true, validate the host inline during the authority
 *   scan and publish the verdict via `extractedHostnameValidated` so `parseImpl`
 *   can skip the redundant `isValidHostname` pass for simple authorities.
 */
function extractHostname(url, urlIsValidHostname, validate = false) {
    let start = 0;
    let end = url.length;
    let hasUpper = false;
    let failedValidation = false; // inline validation failed (always so with a '%')
    let isSpecial = true; // '\' ends the host, unless non-special "scheme://"
    extractedHostnameValidated = false;
    extractedBracketedHost = false;
    if (!urlIsValidHostname) {
        // WHATWG step 1: trim leading/trailing C0 control or space (<= U+0020).
        // Tab/newline elsewhere are handled lazily below.
        while (start < url.length && charCodeAt$1.call(url, start) <= 32) {
            start += 1;
        }
        // "data:"/"javascript:" never reach a host (inline payload; data URLs may be
        // huge). `| 32` lowercases letters only; tab/newline is re-parsed below.
        if ((charCodeAt$1.call(url, start + 4) === 58 /* ':' */ &&
            (charCodeAt$1.call(url, start) | 32) === 100 /* d */ &&
            (charCodeAt$1.call(url, start + 1) | 32) === 97 /* a */ &&
            (charCodeAt$1.call(url, start + 2) | 32) === 116 /* t */ &&
            (charCodeAt$1.call(url, start + 3) | 32) === 97) /* a */ ||
            (charCodeAt$1.call(url, start + 10) === 58 /* ':' */ &&
                (charCodeAt$1.call(url, start) | 32) === 106 /* j */ &&
                (charCodeAt$1.call(url, start + 1) | 32) === 97 /* a */ &&
                (charCodeAt$1.call(url, start + 2) | 32) === 118 /* v */ &&
                (charCodeAt$1.call(url, start + 3) | 32) === 97 /* a */ &&
                (charCodeAt$1.call(url, start + 4) | 32) === 115 /* s */ &&
                (charCodeAt$1.call(url, start + 5) | 32) === 99 /* c */ &&
                (charCodeAt$1.call(url, start + 6) | 32) === 114 /* r */ &&
                (charCodeAt$1.call(url, start + 7) | 32) === 105 /* i */ &&
                (charCodeAt$1.call(url, start + 8) | 32) === 112 /* p */ &&
                (charCodeAt$1.call(url, start + 9) | 32) === 116) /* t */) {
            return null;
        }
        while (end > start + 1 && charCodeAt$1.call(url, end - 1) <= 32) {
            end -= 1;
        }
        if ((charCodeAt$1.call(url, start) === 47 /* '/' */ ||
            charCodeAt$1.call(url, start) === 92) /* '\' */ &&
            (charCodeAt$1.call(url, start + 1) === 47 /* '/' */ ||
                charCodeAt$1.call(url, start + 1) === 92) /* '\' */) {
            // Scheme-relative reference ("//host/path"). Relative to a web page, a
            // special URL, browsers skip any further slashes ("///host").
            start += 2;
            while (charCodeAt$1.call(url, start) === 47 /* '/' */ ||
                charCodeAt$1.call(url, start) === 92 /* '\' */) {
                start += 1;
            }
        }
        else {
            // The scheme ends at the first ":/". Most URLs start with "http://" or
            // "https://", so check for those before searching.
            let indexOfProtocol = charCodeAt$1.call(url, start + 4) === 115 /* 's' */
                ? start + 5
                : start + 4;
            if (charCodeAt$1.call(url, start) !== 104 /* 'h' */ ||
                charCodeAt$1.call(url, start + 1) !== 116 /* 't' */ ||
                charCodeAt$1.call(url, start + 2) !== 116 /* 't' */ ||
                charCodeAt$1.call(url, start + 3) !== 112 /* 'p' */ ||
                charCodeAt$1.call(url, indexOfProtocol) !== 58 /* ':' */ ||
                charCodeAt$1.call(url, indexOfProtocol + 1) !== 47 /* '/' */) {
                indexOfProtocol = url.indexOf(':/', start);
            }
            if (indexOfProtocol !== -1) {
                // "scheme://…". Classify the scheme, then position `start` at the host.
                const special = getSpecialScheme(url, start, indexOfProtocol);
                if (special === 1) {
                    // Special scheme: skip the run of '/' and '\' after it
                    // (special-authority-(ignore-)slashes states; '\' acts as '/').
                    start = indexOfProtocol + 2;
                    while (charCodeAt$1.call(url, start) === 47 /* '/' */ ||
                        charCodeAt$1.call(url, start) === 92 /* '\' */) {
                        start += 1;
                    }
                }
                else if (special === 2) {
                    // file: the host is only what sits between "//" and the next slash, so
                    // "file://h/x" => "h" but "file:///x" / "file:/x" => no host.
                    start = indexOfProtocol + 1;
                    let slashes = 0;
                    while ((charCodeAt$1.call(url, start) === 47 ||
                        charCodeAt$1.call(url, start) === 92) &&
                        slashes < 2) {
                        start += 1;
                        slashes += 1;
                    }
                    if (slashes < 2) {
                        return noHostname(url, urlIsValidHostname, validate);
                    }
                }
                else if (!isScheme(url, start, start + 1)) {
                    // No scheme: one starts with an ASCII letter ("1a://x" is no URL for
                    // browsers). Read the input as an authority, as below.
                    indexOfProtocol = -1;
                }
                else {
                    // Unknown scheme: validate the WHATWG scheme grammar [A-Za-z0-9+.-];
                    // a control char means it was split by a tab/newline (strip + re-parse).
                    for (let i = start; i < indexOfProtocol; i += 1) {
                        const code = charCodeAt$1.call(url, i);
                        if (!isSchemeChar(code)) {
                            if (code === 9 /* tab */ ||
                                code === 10 /* LF */ ||
                                code === 13 /* CR */) {
                                return extractHostname(url.replace(CONTROL_CHARS, ''), urlIsValidHostname, validate);
                            }
                            // A scheme ending at a first ':' (other than a slash-less special
                            // one) makes this ':/' part of an opaque path ("foo:bar://x", no
                            // host), unless a '/', '\', '?' or '#' first puts it in a path,
                            // query or fragment ("a.com/r?u=https://x"). Otherwise no scheme
                            // ends here: this ':/' is an empty port, after a slash-less
                            // special scheme ("http:a.com:/x") or an authority
                            // ("user@host:/x"). Read the input as such below.
                            if (code === 58 /* ':' */ &&
                                getSpecialScheme(url, start, i) !== 1) {
                                for (let j = i; j < indexOfProtocol; j += 1) {
                                    const c = charCodeAt$1.call(url, j);
                                    if (c === 47 || c === 92 || c === 63 || c === 35) {
                                        indexOfProtocol = -1;
                                        break;
                                    }
                                }
                                if (indexOfProtocol !== -1) {
                                    return noHostname(url, urlIsValidHostname, validate);
                                }
                            }
                            indexOfProtocol = -1;
                            break;
                        }
                    }
                    if (indexOfProtocol !== -1) {
                        // A non-special scheme has an authority only after "//" (else it is
                        // an opaque path with no host). `indexOf(':/')` already gave the
                        // first '/'.
                        if (charCodeAt$1.call(url, indexOfProtocol + 2) === 47 /* '/' */) {
                            isSpecial = false;
                            start = indexOfProtocol + 3;
                        }
                        else {
                            return noHostname(url, urlIsValidHostname, validate);
                        }
                    }
                }
            }
            if (indexOfProtocol === -1 &&
                charCodeAt$1.call(url, start) !== 91 /* '[' */) {
                // Cold path: no "scheme://" prefix, and not a bare IPv6 literal (whose
                // first ':' would otherwise look like a scheme separator; "[…]" falls
                // through to the ipv6 handling below). May be a bare host, a host:port,
                // a user@host, a slash-less special scheme ("https:host"), or an opaque
                // URI ("mailto:", "tel:", "urn:…").
                let indexOfColon = -1;
                for (let i = start; i < end; i += 1) {
                    const code = charCodeAt$1.call(url, i);
                    if (code === 9 || code === 10 || code === 13) {
                        return extractHostname(url.replace(CONTROL_CHARS, ''), urlIsValidHostname, validate);
                    }
                    if (code === 58 /* ':' */) {
                        indexOfColon = i;
                        break;
                    }
                    if (code === 47 || code === 92 || code === 63 || code === 35) {
                        break;
                    }
                }
                if (indexOfColon !== -1) {
                    // An '@' before the next delimiter => the ':' is userinfo, not a
                    // scheme ("user:pass@host", "mailto:a@b"): keep the whole authority.
                    // Not after "file:", which has no userinfo and no host without "//".
                    const special = getSpecialScheme(url, start, indexOfColon);
                    let hasIdentifier = false;
                    for (let i = special === 2 ? end : indexOfColon + 1; i < end; i += 1) {
                        const code = charCodeAt$1.call(url, i);
                        if (code === 47 || code === 92 || code === 63 || code === 35) {
                            break;
                        }
                        if (code === 64 /* '@' */) {
                            hasIdentifier = true;
                            break;
                        }
                    }
                    if (!hasIdentifier) {
                        // All-digits after ':' => a bare "host:port" (tldts accepts
                        // hostnames too); keep `start` and let the port handling trim it.
                        // Not after a special scheme though: "http:8080" is a URL.
                        let allDigits = special === 0;
                        let i = indexOfColon + 1;
                        for (; i < end; i += 1) {
                            const code = charCodeAt$1.call(url, i);
                            if (code === 47 || code === 92 || code === 63 || code === 35) {
                                break;
                            }
                            if (code < 48 /* '0' */ || code > 57 /* '9' */) {
                                allDigits = false;
                                break;
                            }
                        }
                        if (i === indexOfColon + 1) {
                            allDigits = false; // nothing after ':' => not a port
                        }
                        if (!allDigits) {
                            if (special === 0) {
                                // No "scheme://" on the cold path and not a special scheme.
                                // A second ':' before the host's end marks a bare, unbracketed
                                // IPv6 literal ("2a01:e35::1"): fall through and let the host
                                // loop + isIp classify it. Without one this is an opaque path
                                // with no host ("mailto:x", "foo:bar").
                                let isBareIpv6 = false;
                                for (let j = indexOfColon + 1; j < end; j += 1) {
                                    const code = charCodeAt$1.call(url, j);
                                    if (code === 47 ||
                                        code === 92 ||
                                        code === 63 ||
                                        code === 35) {
                                        break;
                                    }
                                    if (code === 58 /* ':' */) {
                                        isBareIpv6 = true;
                                        break;
                                    }
                                }
                                // Not a scheme either ("@host:", "a_b:/x"): an authority, if
                                // its ':' starts an empty port (digits were read above).
                                // Browsers have no host for "a_b:x".
                                const next = charCodeAt$1.call(url, i);
                                if (!isBareIpv6 &&
                                    (isScheme(url, start, indexOfColon) ||
                                        (i < end &&
                                            next !== 47 &&
                                            next !== 92 &&
                                            next !== 63 &&
                                            next !== 35))) {
                                    return noHostname(url, urlIsValidHostname, validate);
                                }
                            }
                            else {
                                start = indexOfColon + 1;
                                if (special === 2) {
                                    // file (e.g. "file:\\host"): host only between "//" and next slash.
                                    let slashes = 0;
                                    while ((charCodeAt$1.call(url, start) === 47 ||
                                        charCodeAt$1.call(url, start) === 92) &&
                                        slashes < 2) {
                                        start += 1;
                                        slashes += 1;
                                    }
                                    if (slashes < 2) {
                                        return noHostname(url, urlIsValidHostname, validate);
                                    }
                                }
                                else {
                                    while (charCodeAt$1.call(url, start) === 47 ||
                                        charCodeAt$1.call(url, start) === 92) {
                                        start += 1;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        // Find the host's end: first '/', '?' or '#' (and '\' for special URLs,
        // which WHATWG treats like '/'). Track the last '@' and ':' for userinfo
        // and port, plus the first ':' of the host (reset at each
        // '@') to tell a bare IPv6 (>= 2 colons) from a host:port (exactly one);
        // flag uppercase and a stray tab/newline. The loop is split on `code < 64`
        // so common host characters take fewer comparisons.
        //
        // When `validate`, also accumulate `is-valid.ts`'s checks over the scanned
        // run so a simple authority's host can be validated in this single pass.
        // `vValid` only stays meaningful for a "simple" authority (no userinfo, port,
        // brackets, control or trailing dot); those cases clear it / are rejected by
        // the guard below, falling back to `isValidHostname`.
        let indexOfIdentifier = -1;
        let indexOfPort = -1;
        let indexOfFirstColon = -1;
        let hasControl = false;
        let vValid = validate; // seeded true when validating; cleared on the first invalid char
        let vLastDot = start - 1; // mirrors is-valid.ts `lastDotIndex = -1` at host start
        let vLastCode = -1;
        if (validate && start < end) {
            // First-char rule: must be a valid host char, '.', or '_' (NOT '-').
            const c0 = charCodeAt$1.call(url, start);
            if (
            // Keep these parens: they scope /*@__INLINE__*/ for terser.
            // prettier-ignore
            !(
            /*@__INLINE__*/ (isValidHostnameChar(c0) ||
                c0 === 46 /* '.' */ ||
                c0 === 95 /* '_' */)) ||
                c0 === 45 /* '-' (isValidHostnameChar allows it mid-label, not first) */) {
                vValid = false;
            }
        }
        for (let i = start; i < end; i += 1) {
            const code = charCodeAt$1.call(url, i);
            if (code < 64) {
                if (code === 47 || code === 35 || code === 63) {
                    end = i;
                    break;
                }
                else if (code === 58 /* ':' */) {
                    if (indexOfFirstColon === -1) {
                        indexOfFirstColon = i;
                    }
                    indexOfPort = i;
                }
                else if (code === 9 || code === 10 || code === 13) {
                    hasControl = true;
                }
                else if (validate) {
                    if (code === 46 /* '.' */) {
                        if (i - vLastDot > 64 || vLastCode === 46 || vLastCode === 45) {
                            vValid = false;
                        }
                        vLastDot = i;
                    }
                    else if (code < 48 || code > 57) {
                        // < 64 and not a delimiter/dot/digit => only '-' (45) is a valid
                        // host char here; everything else (space, %, !, etc.) is invalid.
                        // A '-' must also not START a label (the byte right after a '.') —
                        // mirrors is-valid.ts; the first label is covered by the first-char
                        // rule above. (RFC 1034 §3.5 / RFC 1035 §2.3.1 LDH.)
                        if (code !== 45 || vLastCode === 46 /* label-leading '-' */) {
                            vValid = false;
                        }
                    }
                }
            }
            else if (isSpecial && code === 92 /* '\' */) {
                end = i;
                break;
            }
            else if (code === 64 /* '@' */) {
                indexOfIdentifier = i;
                indexOfFirstColon = -1; // colons before '@' are userinfo, not the host
            }
            else if (code >= 65 && code <= 90) {
                hasUpper = true;
            }
            else if (validate && !( /*@__INLINE__*/isValidHostnameChar(code))) {
                // >= 64, not '@'/']'/upper: valid only if a-z, '_', or non-ASCII.
                vValid = false;
            }
            if (validate) {
                vLastCode = code;
            }
        }
        // A tab/newline inside the authority: strip everything and re-parse (rare).
        if (hasControl) {
            return extractHostname(url.replace(CONTROL_CHARS, ''), urlIsValidHostname, validate);
        }
        // Skip userinfo. '>= start' so an empty userinfo ("http://@host") works too.
        if (indexOfIdentifier !== -1 &&
            indexOfIdentifier >= start &&
            indexOfIdentifier < end) {
            start = indexOfIdentifier + 1;
        }
        if (charCodeAt$1.call(url, start) === 91 /* '[' */) {
            // ipv6 address: return what is between the brackets, or null if they are
            // unclosed or followed by anything but a port ("[::1]x"). `parseImpl`
            // checks that they hold an IPv6 address (see `extractedBracketedHost`).
            const closingBracket = url.indexOf(']', start);
            if (closingBracket !== -1 &&
                closingBracket < end &&
                (closingBracket + 1 === end ||
                    charCodeAt$1.call(url, closingBracket + 1) === 58) /* ':' */) {
                extractedBracketedHost = true;
                return url.slice(start + 1, closingBracket).toLowerCase();
            }
            return null;
        }
        else if (indexOfPort !== -1 &&
            indexOfPort > start &&
            indexOfPort < end &&
            // A host:port has exactly one ':' in the host (so its first ':' is its
            // last); a bare, unbracketed IPv6 literal ("2a01:e35::1") has >= 2, so
            // its first ':' precedes the last. Only the former has a ':port' to trim.
            indexOfFirstColon === indexOfPort) {
            end = indexOfPort; // trim ':port'
        }
        // Empty authority ("http://", "file:///path", "//"), unless a tab or
        // newline hides one ("/\t/host"); only reachable here via extraction — a
        // bare valid hostname never lands here.
        if (start >= end) {
            return noHostname(url, urlIsValidHostname, validate);
        }
        // Publish the inline-validation verdict — but only for a "simple" authority,
        // where the scanned run equals the final host: no userinfo skip, no port
        // trim, no brackets, no trailing dot (trimmed below), and length within RFC
        // limits. Anything else leaves it `false` so `parseImpl` re-validates.
        //
        // Every clause below is load-bearing for CORRECTNESS, not just speed: the
        // loop accumulates `vValid` over the whole scanned run (it does not stop at
        // ':' or '@', so any port/userinfo bytes are included), so the verdict is
        // only sound when that run equals the final host. Do not drop a clause as
        // "redundant" — e.g. without `indexOfPort === -1`, `host:8080` would be
        // wrongly accepted.
        if (validate &&
            vValid &&
            indexOfIdentifier === -1 &&
            indexOfPort === -1 &&
            charCodeAt$1.call(url, end - 1) !== 46 /* no trailing dot */ &&
            end - start <= 255 && // total length
            end - vLastDot - 1 <= 63 && // last label length
            vLastCode !== 45 /* last char not '-' */) {
            extractedHostnameValidated = true;
        }
        failedValidation = validate && !vValid;
    }
    // Trim trailing dots
    while (end > start + 1 && charCodeAt$1.call(url, end - 1) === 46 /* '.' */) {
        end -= 1;
    }
    const hostname = start !== 0 || end !== url.length ? url.slice(start, end) : url;
    // Browsers percent-decode the host of a special URL ("%74racker.com" is
    // tracker.com). Only when validating: otherwise the host is kept as written.
    if (failedValidation && isSpecial && hostname.includes('%')) {
        return decodeHostname(hostname);
    }
    if (hasUpper) {
        return hostname.toLowerCase();
    }
    return hostname;
}

// Auto-generated by packages/tldts-utils/bin/ip-mapping.js (Node.js v26.13.1, Unicode 18.0). Do not edit.
//
// Non-ASCII code points that the host parser of browsers deletes, or maps to
// '.', or to digits, 'a'-'f' and 'x' only, as ranges: code points
// `ipMappingFirst[k]` to `ipMappingLast[k]` map, with `value = ipMappingValue[k]`
// and `offset` the position in the range: to nothing if `value` is 0, to the
// character `value + offset` if `value` is below 128, to the decimal number
// `value - 1000 + offset` if `value` is below 2000, and else to the two
// characters `value >> 8` and `value & 255`.
const ipMappingFirst = /*#__PURE__*/ new Uint32Array([170, 173, 178, 185, 739, 847, 4447, 6068, 6155, 7468, 7470, 7472, 7491, 7495, 7496, 7580, 7584, 8203, 8288, 8298, 8304, 8308, 8320, 8336, 8337, 8339, 8450, 8492, 8495, 8496, 8517, 8518, 8553, 8557, 8569, 8573, 9312, 9321, 9398, 9421, 9424, 9447, 9450, 12290, 12644, 12881, 12977, 13170, 13252, 13253, 13256, 42994, 42995, 64256, 65024, 65279, 65294, 65296, 65313, 65336, 65345, 65368, 65377, 65440, 113824, 117974, 117997, 118000, 119155, 119808, 119831, 119834, 119857, 119860, 119883, 119886, 119909, 119912, 119935, 119938, 119961, 119964, 119966, 119987, 119990, 119995, 120013, 120016, 120039, 120042, 120065, 120068, 120071, 120091, 120094, 120117, 120120, 120123, 120143, 120146, 120169, 120172, 120195, 120198, 120221, 120224, 120247, 120250, 120273, 120276, 120299, 120302, 120325, 120328, 120351, 120354, 120377, 120380, 120403, 120406, 120429, 120432, 120455, 120458, 120481, 120782, 120792, 120802, 120812, 120822, 127275, 127277, 127280, 127303, 130032, 917760]);
const ipMappingLast = /*#__PURE__*/ new Uint32Array([170, 173, 179, 185, 739, 847, 4448, 6069, 6159, 7468, 7470, 7473, 7491, 7495, 7497, 7580, 7584, 8203, 8292, 8303, 8304, 8313, 8329, 8336, 8337, 8339, 8450, 8493, 8495, 8497, 8517, 8519, 8553, 8558, 8569, 8574, 9320, 9331, 9403, 9421, 9429, 9447, 9450, 12290, 12644, 12895, 12991, 13170, 13252, 13253, 13256, 42994, 42995, 64256, 65039, 65279, 65294, 65305, 65318, 65336, 65350, 65368, 65377, 65440, 113827, 117979, 117997, 118009, 119162, 119813, 119831, 119839, 119857, 119865, 119883, 119891, 119909, 119917, 119935, 119943, 119961, 119964, 119967, 119987, 119993, 119995, 120013, 120021, 120039, 120047, 120065, 120069, 120073, 120091, 120099, 120117, 120121, 120125, 120143, 120151, 120169, 120177, 120195, 120203, 120221, 120229, 120247, 120255, 120273, 120281, 120299, 120307, 120325, 120333, 120351, 120359, 120377, 120385, 120403, 120411, 120429, 120437, 120455, 120463, 120481, 120791, 120801, 120811, 120821, 120831, 127275, 127277, 127285, 127303, 130041, 917999]);
const ipMappingValue = /*#__PURE__*/ new Uint16Array([97, 0, 50, 49, 120, 0, 0, 0, 0, 97, 98, 100, 97, 98, 100, 99, 102, 0, 0, 0, 48, 52, 48, 97, 101, 120, 99, 98, 101, 101, 100, 100, 120, 99, 120, 99, 49, 1010, 97, 120, 97, 120, 48, 46, 0, 1021, 1036, 25697, 25443, 25444, 25698, 99, 102, 26214, 0, 0, 46, 48, 97, 120, 97, 120, 46, 0, 0, 97, 120, 48, 0, 97, 120, 97, 120, 97, 120, 97, 120, 97, 120, 97, 120, 97, 99, 120, 97, 102, 120, 97, 120, 97, 120, 97, 100, 120, 97, 120, 97, 100, 120, 97, 120, 97, 120, 97, 120, 97, 120, 97, 120, 97, 120, 97, 120, 97, 120, 97, 120, 97, 120, 97, 120, 97, 120, 97, 120, 48, 48, 48, 48, 48, 99, 25444, 97, 120, 48, 0]);
// Bit `(cp >> 8) & 31` of `ipMappingBlocks[cp >> 13]` is set when the block of
// 256 code points holding `cp` (below U+10000) holds any of them.
const ipMappingBlocks = /*#__PURE__*/ new Uint32Array([562167821, 983059, 0, 0, 0, 128, 0, 3355443200]);

/**
 * Detection of IP addresses, as defined by the host parser of the WHATWG URL
 * standard (https://url.spec.whatwg.org/#host-parsing), which browsers follow.
 * Addresses are recognized, never rewritten: `0x7f.1` is 127.0.0.1 for a
 * browser, hence an IP here, but stays `0x7f.1`.
 */
/**
 * Value of the hexadecimal digit `code` (0 to 15), or 16 if it is not one.
 */
function hexValue(code) {
    if (code >= 48 && code <= 57) {
        return code - 48; // 0-9
    }
    const letter = code | 32; // lower-case
    return letter >= 97 && letter <= 102 ? letter - 87 : 16; // a-f
}
/**
 * Check if `hostname` is an IPv4 address: one to four numbers separated by
 * dots, each one decimal, octal (leading `0`) or hexadecimal (leading `0x`).
 * The last number fills the bytes the others leave, so `127.1` and
 * `2130706433` are both 127.0.0.1.
 * https://url.spec.whatwg.org/#concept-ipv4-parser
 */
function isIpv4(hostname) {
    const end = hostname.length;
    let i = 0;
    for (let numbers = 1; numbers <= 4; numbers += 1) {
        let radix = 10;
        if (i + 1 < end && hostname.charCodeAt(i) === 48 /* '0' */) {
            radix = 8;
            if ((hostname.charCodeAt(i + 1) | 32) === 120 /* 'x' */) {
                radix = 16;
                i += 2;
            }
        }
        const start = i;
        let value = 0;
        for (; i < end; i += 1) {
            const code = hostname.charCodeAt(i);
            if (code === 46 /* '.' */) {
                break;
            }
            const digit = hexValue(code);
            if (digit >= radix) {
                return false;
            }
            value = value * radix + digit;
        }
        // A number has digits, except "0x" which is 0.
        if (i === start && radix !== 16) {
            return false;
        }
        if (i === end) {
            return value <= 0xffffffff >>> (8 * (numbers - 1));
        }
        if (value > 255) {
            return false;
        }
        i += 1; // '.'
    }
    return false;
}
/**
 * Check if `hostname[i, end)` is made of four decimal numbers separated by
 * dots, each one between 0 and 255 and without leading zero.
 */
function isDottedDecimal(hostname, i, end) {
    for (let numbers = 1; numbers <= 4; numbers += 1) {
        const start = i;
        let value = 0;
        for (; i < end; i += 1) {
            const digit = hostname.charCodeAt(i) - 48;
            if (digit < 0 || digit > 9) {
                break;
            }
            value = value * 10 + digit;
            // Only a leading zero keeps a number of several digits below 10.
            if (value > 255 || (value < 10 && i !== start)) {
                return false;
            }
        }
        if (i === start) {
            return false;
        }
        if (numbers < 4) {
            if (hostname.charCodeAt(i) !== 46 /* '.' */) {
                return false;
            }
            i += 1;
        }
    }
    return i === end;
}
/**
 * Check if `hostname` is an IPv6 address, with or without its brackets: eight
 * groups of one to four hexadecimal digits separated by colons, where a `::`
 * may stand once for one or more missing groups, and a dotted-decimal IPv4
 * address may stand for the last two.
 * https://url.spec.whatwg.org/#concept-ipv6-parser
 */
function isIpv6(hostname) {
    let i = 0;
    let end = hostname.length;
    if (hostname.charCodeAt(0) === 91 /* '[' */) {
        if (hostname.charCodeAt(end - 1) !== 93 /* ']' */) {
            return false;
        }
        i = 1;
        end -= 1;
    }
    // An address only starts with a ':' if it starts with "::".
    if (i < end && hostname.charCodeAt(i) === 58 /* ':' */) {
        if (i + 1 === end || hostname.charCodeAt(i + 1) !== 58 /* ':' */) {
            return false;
        }
        i += 1;
    }
    let groups = 0;
    let compressed = false; // "::" was seen, and counted as one group
    // Here `i` is where a group starts: a ':' can only be the second of a "::".
    while (i < end && groups < 8) {
        if (hostname.charCodeAt(i) === 58 /* ':' */) {
            if (compressed) {
                return false;
            }
            compressed = true;
            groups += 1;
            i += 1;
            continue;
        }
        const start = i;
        while (i < end &&
            i - start < 4 &&
            hexValue(hostname.charCodeAt(i)) !== 16) {
            i += 1;
        }
        if (i === start) {
            return false;
        }
        if (i === end) {
            return compressed || groups === 7;
        }
        if (hostname.charCodeAt(i) === 46 /* '.' */) {
            return ((compressed ? groups <= 6 : groups === 6) &&
                isDottedDecimal(hostname, start, end));
        }
        // Anything else is a ':' followed by another group, or by a ':'.
        if (hostname.charCodeAt(i) !== 58 /* ':' */ || i + 1 === end) {
            return false;
        }
        groups += 1;
        i += 1;
    }
    return compressed && i === end;
}
/**
 * What the host parser of browsers maps the non-ASCII code point `cp` to, as
 * far as IP detection goes: nothing (deleted), '.', digits, 'a'-'f' or 'x', or
 * else 'g', standing for any character that keeps a label from being a number.
 * https://www.unicode.org/reports/tr46/#Processing
 */
function mapCodePoint(cp) {
    // Most letters, as in internationalized domain names, are in blocks of the
    // table without any entry.
    if (cp < 0x10000 &&
        ((ipMappingBlocks[cp >> 13] >>> ((cp >> 8) & 31)) & 1) === 0) {
        return 'g';
    }
    let low = 0;
    let high = ipMappingFirst.length - 1;
    while (low <= high) {
        const mid = (low + high) >>> 1;
        if (cp < ipMappingFirst[mid]) {
            high = mid - 1;
        }
        else if (cp > ipMappingLast[mid]) {
            low = mid + 1;
        }
        else {
            const value = ipMappingValue[mid];
            const offset = cp - ipMappingFirst[mid];
            if (value === 0) {
                return '';
            }
            if (value < 128) {
                return String.fromCharCode(value + offset);
            }
            if (value < 2000) {
                return String(value - 1000 + offset);
            }
            return String.fromCharCode(value >> 8, value & 255);
        }
    }
    return 'g';
}
/**
 * `isIp` for a host holding non-ASCII characters, read as browsers read it:
 * they first map some characters to digits or dots and delete others, so that
 * `１２７.０.０.１`, or `127.0.0.1` followed by a zero-width space, is 127.0.0.1
 * for them. The host is mapped the same way, as far as IP detection goes, and
 * checked again.
 */
function isMappedIp(hostname) {
    // Most such hosts are internationalized domain names, with a character that
    // keeps their last label from being a number: find it first.
    for (let i = hostname.length - 1; i >= 0; i -= 1) {
        let cp = hostname.charCodeAt(i);
        if (cp === 46 /* '.' */) {
            break;
        }
        if (cp < 128) {
            if (hexValue(cp) === 16 && (cp | 32) !== 120 /* 'x' */) {
                return false;
            }
            continue;
        }
        // Most letters are in blocks of 256 code points without any entry.
        if (cp < 0xd800 &&
            ((ipMappingBlocks[cp >> 13] >>> ((cp >> 8) & 31)) & 1) === 0) {
            return false;
        }
        if (cp >= 0xdc00 && cp <= 0xdfff && i > 0) {
            const high = hostname.charCodeAt(i - 1);
            if (high >= 0xd800 && high <= 0xdbff) {
                cp = (high - 0xd800) * 0x400 + (cp - 0xdc00) + 0x10000;
                i -= 1;
            }
        }
        const mapped = mapCodePoint(cp);
        if (mapped === 'g') {
            return false;
        }
        if (mapped === '.') {
            break;
        }
    }
    // Browsers read an IPv6 address, between brackets, as written: a host
    // holding non-ASCII characters is never one.
    if (hostname.includes(':')) {
        return false;
    }
    let ascii = '';
    for (let i = 0; i < hostname.length; i += 1) {
        const code = hostname.charCodeAt(i);
        if (code < 128) {
            ascii += hostname.charAt(i);
        }
        else {
            let cp = code;
            if (code >= 0xd800 && code <= 0xdbff) {
                const low = hostname.charCodeAt(i + 1);
                if (low >= 0xdc00 && low <= 0xdfff) {
                    cp = (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
                    i += 1;
                }
            }
            ascii += mapCodePoint(cp);
        }
    }
    // Trailing dots go, as callers remove them from `hostname`.
    let end = ascii.length;
    while (end > 1 && ascii.charCodeAt(end - 1) === 46 /* '.' */) {
        end -= 1;
    }
    return isIp(ascii.slice(0, end));
}
/**
 * For a host ending in a number without being an IP address in ASCII: `null`,
 * unless it holds non-ASCII characters, which browsers may map (see
 * `isMappedIp`).
 */
function isNonAsciiIp(hostname) {
    for (let i = 0; i < hostname.length; i += 1) {
        if (hostname.charCodeAt(i) >= 128) {
            return isMappedIp(hostname);
        }
    }
    return null;
}
/**
 * Check if `hostname` is an IP address (either IPv4 or IPv6).
 *
 * The answer is `null` for a host ending in a number without being an IPv4
 * address (`1.2.3.4.5`, `example.123`): browsers read such a host as an
 * address and nothing else, so it is not a valid host, and never a domain.
 * `hostname` has no trailing dot: callers strip them.
 */
function isIp(hostname) {
    // Go backward over the digits ending `hostname`, decimal ones first, then
    // hexadecimal ones, down to `code`, the character before them (NaN before
    // the start of `hostname`). It tells what `hostname` may be, and most often
    // that it is not an address.
    const last = hostname.length - 1;
    let i = last;
    let code = hostname.charCodeAt(i);
    while (code >= 48 && code <= 57 /* 0-9 */) {
        i -= 1;
        code = hostname.charCodeAt(i);
    }
    const decimal = i;
    while (hexValue(code) !== 16) {
        i -= 1;
        code = hostname.charCodeAt(i);
    }
    // An IPv6 address ends with a group, which follows a ':', with "::" or
    // with a ']'. Its last label is not a number then.
    if (code === 58 /* ':' */ || code === 93 /* ']' */) {
        return isIpv6(hostname);
    }
    // An IPv4 address ends with a number: a last label only made of decimal
    // digits, or of "0x" followed by hexadecimal digits. An IPv6 address ending
    // with an IPv4 one ends with a number too.
    // https://url.spec.whatwg.org/#ends-in-a-number-checker
    if ((i === decimal && i !== last && (code === 46 /* '.' */ || i === -1)) ||
        ((code | 32) === 120 /* 'x' */ &&
            hostname.charCodeAt(i - 1) === 48 /* '0' */ &&
            (i === 1 || hostname.charCodeAt(i - 2) === 46)) /* '.' */) {
        return isIpv4(hostname) || isIpv6(hostname) ? true : isNonAsciiIp(hostname);
    }
    // A non-ASCII character right before the digits ending `hostname`, or one
    // or two characters before their "x", may be one that browsers map to a
    // digit or a dot, or delete: `hostname` may end in a number for them.
    return code >= 128 ||
        ((code | 32) === 120 /* 'x' */ &&
            (hostname.charCodeAt(i - 1) >= 128 || hostname.charCodeAt(i - 2) >= 128))
        ? isMappedIp(hostname)
        : false;
}

/**
 * Special-use domain names from the IANA "Special-Use Domain Names" registry:
 * the authoritative list, created by RFC 6761 and maintained as new RFCs add to
 * it: https://www.iana.org/assignments/special-use-domain-names/
 * Snapshot: 2026-05-24. (RFC 6761 is not obsoleted; draft-hoffman-rfc6761bis
 * proposes to retire its prose but keep this registry, so the registry is the
 * source of truth; re-sync this list against it.)
 *
 * These names never correspond to a public registration, yet neither
 * `isIcann` nor `isPrivate` marks one as special-use: most are absent from the
 * Public Suffix List (so `a.test` looks like a registrable domain), and the
 * few that are listed (`onion`, `home.arpa`) appear there as ordinary ICANN
 * suffixes. `isSpecialUse` is the single signal that covers them all.
 *
 * Per the registry and RFC 6761 ("and any names falling within these domains"),
 * the designation covers each listed name AND all of its sub-domains. DNS labels
 * are case-insensitive (RFC 4343); `hostname` is expected to be already
 * lower-cased and trailing-dot-stripped, as produced by `extractHostname`, the
 * same normalization the Public-Suffix-List lookup relies on.
 *
 * Two groups of registry entries are intentionally excluded: the numeric
 * reverse-DNS delegation zones (`10.in-addr.arpa`, the `*.ip6.arpa` ranges, …),
 * which are reverse-DNS PTR zones rather than hostnames and whose parents
 * (`in-addr.arpa`/`ip6.arpa`) are already in the Public Suffix List; and the
 * deprecated `eap-noob.arpa` entry.
 */
const SPECIAL_USE_DOMAINS = [
    'test', // RFC 6761
    'localhost', // RFC 6761
    'invalid', // RFC 6761
    'example', // RFC 6761
    'example.com', // RFC 6761
    'example.net', // RFC 6761
    'example.org', // RFC 6761
    'local', // RFC 6762 (mDNS)
    'onion', // RFC 7686 (Tor)
    'alt', // RFC 9476
    'home.arpa', // RFC 8375
    'ipv4only.arpa', // RFC 8880
    'resolver.arpa', // RFC 9462
    'service.arpa', // RFC 9665
    '6tisch.arpa', // RFC 9031
    'eap.arpa', // RFC 9965
];
/**
 * Return `true` if `hostname` is, or is a sub-domain of, a special-use domain
 * (see the registry note above). Expects an already-normalized `hostname`.
 */
function isSpecialUse(hostname) {
    for (const name of SPECIAL_USE_DOMAINS) {
        // Match on a label boundary: `hostname` is either exactly `name` or ends
        // with `.name` (so `latest` is not matched by `test`, nor `myexample.com`
        // by `example.com`).
        if (hostname.endsWith(name) &&
            (hostname.length === name.length ||
                hostname.charCodeAt(hostname.length - name.length - 1) === 46) /* '.' */) {
            return true;
        }
    }
    return false;
}

/**
 * Implements fast shallow verification of hostnames. This does not perform a
 * struct check on the content of labels (classes of Unicode characters, etc.)
 * but instead check that the structure is valid (number of labels, length of
 * labels, etc.).
 *
 * If you need stricter validation, consider using an external library.
 */
// `charCodeAt.call(s, i)`, not `s.charCodeAt(i)`: V8 specializes a
// `s.charCodeAt` call site for at most four kinds of strings (flat, sliced,
// concatenated, internalized, of one or two bytes per character...). Past
// that, it finds the method through a generic cache and no longer inlines it,
// on every call. Hostnames come here from callers and from URLs, of any kind.
// eslint-disable-next-line @typescript-eslint/unbound-method
const charCodeAt = String.prototype.charCodeAt;
// KEEP IN SYNC with `extract-hostname.ts` `isValidHostnameChar` + its inline
// scan/verdict, which duplicate these structural rules to validate during
// extraction (a perf fusion). That copy additionally accepts A-Z (the host is
// not yet lowercased there) and folds in '-' / '_'. Any change to the accepted
// character set or the label/length rules here must be mirrored there.
function isValidAscii(code) {
    return ((code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code > 127);
}
/**
 * Check if a hostname string is valid. It's usually a preliminary check before
 * trying to use getDomain or anything else.
 *
 * Beware: it does not check if the TLD exists.
 */
function isValidHostname (hostname) {
    if (hostname.length > 255) {
        return false;
    }
    if (hostname.length === 0) {
        return false;
    }
    if (
    /*@__INLINE__*/ !isValidAscii(charCodeAt.call(hostname, 0)) &&
        charCodeAt.call(hostname, 0) !== 46 && // '.' (dot)
        charCodeAt.call(hostname, 0) !== 95 // '_' (underscore)
    ) {
        return false;
    }
    // Validate hostname according to RFC
    let lastDotIndex = -1;
    let lastCharCode = -1;
    const len = hostname.length;
    for (let i = 0; i < len; i += 1) {
        const code = charCodeAt.call(hostname, i);
        if (code === 46 /* '.' */) {
            if (
            // Check that previous label is < 63 bytes long (64 = 63 + '.')
            i - lastDotIndex > 64 ||
                // Check that previous character was not already a '.'
                lastCharCode === 46 ||
                // Check that the previous label does not end with '-' (RFC 1035 §2.3.1 LDH).
                // '_' is intentionally NOT restricted: DNS allows any octet (RFC 2181 §11) and
                // WHATWG URL does not treat '_' as a forbidden host code point.
                lastCharCode === 45) {
                return false;
            }
            lastDotIndex = i;
        }
        else if (
        // A forbidden character in the label...
        // Keep these parens: they scope /*@__INLINE__*/ for terser.
        // prettier-ignore
        !( /*@__INLINE__*/(isValidAscii(code) || code === 45 || code === 95)) ||
            // ...or a '-' starting a label (the byte right after a '.'). A label must
            // not begin with a hyphen (RFC 1034 §3.5 / RFC 1035 §2.3.1 LDH, as amended
            // by RFC 1123 §2.1; cf. UTS #46 CheckHyphens). The first label is covered by
            // the leading-character guard above; mirrors the trailing-'-' rule below.
            (code === 45 && lastCharCode === 46)) {
            return false;
        }
        lastCharCode = code;
    }
    return (
    // Check that last label is shorter than 63 chars
    len - lastDotIndex - 1 <= 63 &&
        // Check that the last character is an allowed trailing label character.
        // Since we already checked that the char is a valid hostname character,
        // we only need to check that it's different from '-'.
        lastCharCode !== 45);
}

/**
 * Apply `options.extraSuffixes` to the built-in lookup result in `out`, as if
 * they were part of the list (`isException`: the built-in winner is an
 * exception rule). As in browsers, the longest match prevails and an exception
 * beats a rule of the same length. Remaining ties go to the built-in match
 * (unless it matched no rule: both flags falsy), then to `icann`.
 */
function extraSuffixLookup(hostname, options, isException, out) {
    const suffix = out.publicSuffix;
    if (suffix === null) {
        return;
    }
    // Best extra exception and rule, as start indices in `hostname` (smaller is
    // longer; `none` if unmatched), and whether each is ICANN.
    const none = hostname.length + 1;
    let exception = none;
    let exceptionIsIcann = false;
    let rule = none;
    let ruleIsIcann = false;
    const extra = options.extraSuffixes;
    for (let section = 0; section < 2; section += 1) {
        const isIcann = section === 0;
        const rules = isIcann
            ? options.allowIcannDomains && extra.icann
            : options.allowPrivateDomains && extra.private;
        if (!Array.isArray(rules)) {
            continue;
        }
        for (const r of rules) {
            // Sparse or untyped lists may hold non-strings.
            if (typeof r !== 'string') {
                continue;
            }
            const exceptionRule = r.startsWith('!');
            const wildcard = r.startsWith('*.');
            const body = exceptionRule ? r.slice(1) : wildcard ? r.slice(2) : r;
            // Skip empty rules, and exceptions without a parent ('!p').
            if (body === '' ||
                (exceptionRule && !body.includes('.')) ||
                !shareSameDomainSuffix(hostname, body)) {
                continue;
            }
            let start = hostname.length - body.length;
            // Strict `<`: on a tie, the first match (`icann` first) wins.
            if (exceptionRule) {
                if (start < exception) {
                    exception = start;
                    exceptionIsIcann = isIcann;
                }
                continue;
            }
            // `*.p` also matches `p`, else one more non-empty label.
            if (wildcard && start > 1 && hostname.charCodeAt(start - 2) !== 46) {
                start = hostname.lastIndexOf('.', start - 2) + 1;
            }
            if (start < rule) {
                rule = start;
                ruleIsIcann = isIcann;
            }
        }
    }
    // Start of the built-in match: an exception starts one label left of its
    // suffix.
    const suffixStart = hostname.length - suffix.length;
    const builtin = isException
        ? hostname.lastIndexOf('.', suffixStart - 2) + 1
        : suffixStart;
    // An exception wins ties with rules; a built-in exception wins ties with
    // an extra one.
    if (exception <= rule &&
        (isException ? exception < builtin : exception <= builtin)) {
        out.publicSuffix = hostname.slice(hostname.indexOf('.', exception) + 1);
        out.isIcann = exceptionIsIcann;
        out.isPrivate = !exceptionIsIcann;
    }
    else if (rule < builtin ||
        (rule === builtin && !out.isIcann && !out.isPrivate)) {
        out.publicSuffix = hostname.slice(rule);
        out.isIcann = ruleIsIcann;
        out.isPrivate = !ruleIsIcann;
    }
}

function setDefaultsImpl({ allowIcannDomains = true, allowPrivateDomains = false, detectIp = true, detectSpecialUse = false, extraSuffixes = null, extractHostname = true, mixedInputs = true, validHosts = null, validateHostname = true, }) {
    return {
        allowIcannDomains,
        allowPrivateDomains,
        detectIp,
        detectSpecialUse,
        extraSuffixes,
        extractHostname,
        mixedInputs,
        validHosts,
        validateHostname,
    };
}
const DEFAULT_OPTIONS = /*@__INLINE__*/ setDefaultsImpl({});
function setDefaults(options) {
    // `null` as well: untyped callers pass it to mean "no options".
    if (options === undefined || options === null) {
        return DEFAULT_OPTIONS;
    }
    return /*@__INLINE__*/ setDefaultsImpl(options);
}

/**
 * Returns the subdomain of a hostname string
 */
function getSubdomain(hostname, domain) {
    // If `hostname` and `domain` are the same, then there is no sub-domain
    if (domain.length === hostname.length) {
        return '';
    }
    return hostname.slice(0, -domain.length - 1);
}

/**
 * Implement a factory allowing to plug different implementations of suffix
 * lookup (e.g.: using a trie or the packed hashes datastructures). This is used
 * and exposed in `tldts.ts` and `tldts-experimental.ts` bundle entrypoints.
 */
function getEmptyResult() {
    return {
        domain: null,
        domainWithoutSuffix: null,
        hostname: null,
        isIcann: null,
        isIp: null,
        isPrivate: null,
        isSpecialUse: null,
        publicSuffix: null,
        subdomain: null,
    };
}
function resetResult(result) {
    result.domain = null;
    result.domainWithoutSuffix = null;
    result.hostname = null;
    result.isIcann = null;
    result.isIp = null;
    result.isPrivate = null;
    result.isSpecialUse = null;
    result.publicSuffix = null;
    result.subdomain = null;
}
function parseImpl(url, step, suffixLookup, partialOptions, result) {
    const options = /*@__INLINE__*/ setDefaults(partialOptions);
    // Very fast approximate check to make sure `url` is a string. This is needed
    // because the library will not necessarily be used in a typed setup and
    // values of arbitrary types might be given as argument.
    if (typeof url !== 'string') {
        return result;
    }
    // Extract hostname from `url` only if needed. This can be made optional
    // using `options.extractHostname`. This option will typically be used
    // whenever we are sure the inputs to `parse` are already hostnames and not
    // arbitrary URLs.
    //
    // `mixedInput` allows to specify if we expect a mix of URLs and hostnames
    // as input. If only hostnames are expected then `extractHostname` can be
    // set to `false` to speed-up parsing. If only URLs are expected then
    // `mixedInputs` can be set to `false`. The `mixedInputs` is only a hint
    // and will not change the behavior of the library.
    // Whether `url` itself was already a valid hostname (only computed on the
    // mixedInputs path). Lets us skip the post-extraction validation below when
    // extractHostname returned `url` unchanged (same reference).
    let urlIsValid = false;
    if (!options.extractHostname) {
        // Trim trailing dots as extractHostname does (`new URL()` keeps them).
        let end = url.length;
        while (end > 1 && url.charCodeAt(end - 1) === 46 /* '.' */) {
            end -= 1;
        }
        result.hostname = end === url.length ? url : url.slice(0, end);
    }
    else if (options.mixedInputs) {
        urlIsValid = isValidHostname(url);
        result.hostname = extractHostname(url, urlIsValid, options.validateHostname);
    }
    else {
        result.hostname = extractHostname(url, false, options.validateHostname);
    }
    // A host in brackets is an IPv6 address, or the URL is invalid, as browsers
    // read it: "http://[1.2.3.4]/" and "http://[a.com]/" have no hostname. An
    // IPv4 address has no ':', every IPv6 address has one.
    if (options.extractHostname &&
        extractedBracketedHost &&
        result.hostname !== null) {
        if (isIp(result.hostname) !== true || !result.hostname.includes(':')) {
            result.hostname = null;
            return result;
        }
        if (options.detectIp) {
            result.isIp = true;
            return result;
        }
    }
    // Check if `hostname` is a valid ip address
    if (options.detectIp && result.hostname !== null) {
        const isIpAddress = isIp(result.hostname);
        result.isIp = isIpAddress === true;
        if (result.isIp) {
            return result;
        }
        // `null`: the host ends in a number, as an IPv4 address, without being
        // one. It is not a valid host then, and never a domain name.
        if (isIpAddress === null &&
            options.validateHostname &&
            options.extractHostname) {
            result.hostname = null;
            return result;
        }
    }
    // Perform hostname validation if enabled. If hostname is not valid, no need to
    // go further as there will be no valid domain or sub-domain. This validation
    // is applied before any early returns to ensure consistent behavior across
    // all API methods including getHostname().
    if (options.validateHostname &&
        options.extractHostname &&
        result.hostname !== null &&
        // Skip the re-scan when `url` was already validated and extractHostname
        // returned it unchanged (same reference => identical string, still valid).
        !(urlIsValid && result.hostname === url) &&
        // Skip the re-scan when extractHostname already validated the host inline
        // (a confirmed-valid simple authority — see extract-hostname.ts).
        !extractedHostnameValidated &&
        !isValidHostname(result.hostname)) {
        result.hostname = null;
        return result;
    }
    if (step === 0 /* FLAG.HOSTNAME */ || result.hostname === null) {
        return result;
    }
    // Flag special-use domains, only when opted in (`detectSpecialUse`) and only
    // for the full `parse()` result (FLAG.ALL). Computed here, before the
    // public-suffix/domain early-returns below, so single-label names like
    // `localhost` (which have no registrable domain) are still flagged.
    if (step === 5 /* FLAG.ALL */ && options.detectSpecialUse) {
        result.isSpecialUse = isSpecialUse(result.hostname);
    }
    // Extract public suffix (`isException`: the winner is an exception rule)
    const isException = suffixLookup(result.hostname, options, result);
    if (options.extraSuffixes !== null) {
        extraSuffixLookup(result.hostname, options, isException === true, result);
    }
    if (step === 2 /* FLAG.PUBLIC_SUFFIX */ || result.publicSuffix === null) {
        return result;
    }
    // Extract domain
    result.domain = getDomain(result.publicSuffix, result.hostname, options);
    if (step === 3 /* FLAG.DOMAIN */ || result.domain === null) {
        return result;
    }
    // Extract subdomain
    result.subdomain = getSubdomain(result.hostname, result.domain);
    if (step === 4 /* FLAG.SUB_DOMAIN */) {
        return result;
    }
    // Extract domain without suffix
    result.domainWithoutSuffix = getDomainWithoutSuffix(result.domain, result.publicSuffix);
    return result;
}

function fastPath (hostname, options, out) {
    // Fast path for very popular suffixes; this allows to by-pass lookup
    // completely as well as any extra allocation or string manipulation.
    if (!options.allowPrivateDomains &&
        options.allowIcannDomains &&
        hostname.length > 3) {
        const last = hostname.length - 1;
        const c3 = hostname.charCodeAt(last);
        const c2 = hostname.charCodeAt(last - 1);
        const c1 = hostname.charCodeAt(last - 2);
        const c0 = hostname.charCodeAt(last - 3);
        if (c3 === 109 /* 'm' */ &&
            c2 === 111 /* 'o' */ &&
            c1 === 99 /* 'c' */ &&
            c0 === 46 /* '.' */) {
            out.isIcann = true;
            out.isPrivate = false;
            out.publicSuffix = 'com';
            return true;
        }
        else if (c3 === 103 /* 'g' */ &&
            c2 === 114 /* 'r' */ &&
            c1 === 111 /* 'o' */ &&
            c0 === 46 /* '.' */) {
            out.isIcann = true;
            out.isPrivate = false;
            out.publicSuffix = 'org';
            return true;
        }
        else if (c3 === 117 /* 'u' */ &&
            c2 === 100 /* 'd' */ &&
            c1 === 101 /* 'e' */ &&
            c0 === 46 /* '.' */) {
            out.isIcann = true;
            out.isPrivate = false;
            out.publicSuffix = 'edu';
            return true;
        }
        else if (c3 === 118 /* 'v' */ &&
            c2 === 111 /* 'o' */ &&
            c1 === 103 /* 'g' */ &&
            c0 === 46 /* '.' */) {
            out.isIcann = true;
            out.isPrivate = false;
            out.publicSuffix = 'gov';
            return true;
        }
        else if (c3 === 116 /* 't' */ &&
            c2 === 101 /* 'e' */ &&
            c1 === 110 /* 'n' */ &&
            c0 === 46 /* '.' */) {
            out.isIcann = true;
            out.isPrivate = false;
            out.publicSuffix = 'net';
            return true;
        }
        else if (c3 === 101 /* 'e' */ &&
            c2 === 100 /* 'd' */ &&
            c1 === 46 /* '.' */) {
            out.isIcann = true;
            out.isPrivate = false;
            out.publicSuffix = 'de';
            return true;
        }
    }
    return false;
}

exports.fastPathLookup = fastPath;
exports.getEmptyResult = getEmptyResult;
exports.parseImpl = parseImpl;
exports.resetResult = resetResult;
exports.setDefaults = setDefaults;
//# sourceMappingURL=index.js.map
