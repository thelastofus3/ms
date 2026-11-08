package room;

import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletRequestWrapper;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.time.Clock;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/** Authentication identity trusts only explicitly configured ingress peers. */
@Component
public final class AuthClientAddress {
    static final String HEADER = "X-Room-Client-IP";
    private record CachedAddresses(Instant until, Set<String> addresses) {}
    @FunctionalInterface interface AddressLookup { InetAddress[] lookup(String hostname) throws UnknownHostException; }
    private final Set<String> numericProxies;
    private final List<String> hostnameProxies;
    private final Map<String, CachedAddresses> cache = new ConcurrentHashMap<>();
    private final AddressLookup lookup;
    private final Clock clock;

    @Autowired public AuthClientAddress(@Value("${room.auth.trusted-proxies:}") String proxies) {
        this(proxies, InetAddress::getAllByName, Clock.systemUTC());
    }

    AuthClientAddress(String proxies, AddressLookup lookup, Clock clock) {
        this.lookup = lookup;
        this.clock = clock;
        var numeric = new HashSet<String>();
        var hostnames = new LinkedHashSet<String>();
        for (String configured : Objects.requireNonNullElse(proxies, "").split(",")) {
            String value = configured.trim();
            if (value.isEmpty()) continue;
            String address = numericAddress(value);
            if (address != null) numeric.add(address);
            else {
                if (value.length() > 253 || value.matches("[0-9.]+") || !value.matches("[A-Za-z0-9][A-Za-z0-9.-]*"))
                    throw new IllegalArgumentException("Trusted auth proxies must be numeric IP addresses or DNS hostnames");
                hostnames.add(value.toLowerCase(Locale.ROOT));
            }
        }
        numericProxies = Set.copyOf(numeric);
        hostnameProxies = List.copyOf(hostnames);
    }

    public String resolve(HttpServletRequest request) {
        ServletRequest unwrapped = request;
        while (unwrapped instanceof ServletRequestWrapper wrapper) unwrapped = wrapper.getRequest();
        String peer = numericAddress(unwrapped.getRemoteAddr());
        if (peer == null) return "unknown";
        if (!(unwrapped instanceof HttpServletRequest original)) return peer;
        var headers = original.getHeaders(HEADER);
        if (headers == null || !headers.hasMoreElements()) return peer;
        String client = numericAddress(headers.nextElement());
        if (client == null || headers.hasMoreElements()) return peer;
        return trusted(peer) ? client : peer;
    }

    private boolean trusted(String peer) {
        if (numericProxies.contains(peer)) return true;
        var now = clock.instant();
        for (String hostname : hostnameProxies) {
            var resolved = cache.compute(hostname, (name, previous) -> {
                if (previous != null && previous.until().isAfter(now)) return previous;
                var addresses = new HashSet<String>();
                try {
                    for (var address : lookup.lookup(name)) addresses.add(address.getHostAddress().toLowerCase(Locale.ROOT));
                } catch (UnknownHostException failure) {
                    // A missing/restarted ingress cannot inherit stale trust after refresh.
                }
                return new CachedAddresses(now.plusSeconds(10), Set.copyOf(addresses));
            });
            if (resolved.addresses().contains(peer)) return true;
        }
        return false;
    }

    static String numericAddress(String value) {
        if (value == null || value.isEmpty() || value.length() > 45) return null;
        if (value.indexOf(':') >= 0) {
            if (!value.matches("[0-9A-Fa-f:.]+")) return null;
            try { return InetAddress.getByName(value).getHostAddress().toLowerCase(Locale.ROOT); }
            catch (UnknownHostException invalid) { return null; }
        }
        var octets = value.split("\\.", -1);
        if (octets.length != 4) return null;
        for (String octet : octets) {
            if (!octet.matches("0|[1-9][0-9]{0,2}") || Integer.parseInt(octet) > 255) return null;
        }
        return String.join(".", octets);
    }
}
