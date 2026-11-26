/**
 * Detection of IP addresses, as defined by the host parser of the WHATWG URL
 * standard (https://url.spec.whatwg.org/#host-parsing), which browsers follow.
 * Addresses are recognized, never rewritten: `0x7f.1` is 127.0.0.1 for a
 * browser, hence an IP here, but stays `0x7f.1`.
 */
/**
 * Check if `hostname` is an IP address (either IPv4 or IPv6).
 *
 * The answer is `null` for a host ending in a number without being an IPv4
 * address (`1.2.3.4.5`, `example.123`): browsers read such a host as an
 * address and nothing else, so it is not a valid host, and never a domain.
 * `hostname` has no trailing dot: callers strip them.
 */
export default function isIp(hostname: string): boolean | null;
