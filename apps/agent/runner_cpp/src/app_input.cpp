#include "foothold/app_input.hpp"

#include <algorithm>
#include <cctype>
#include <charconv>
#include <cmath>
#include <cstdlib>
#include <utility>

namespace foothold {
namespace {
// Same bits as runner.cpp (Unitree wireless_remote key bits).
constexpr std::uint16_t r1 = 1 << 0, l1 = 1 << 1, r2 = 1 << 4, l2 = 1 << 5;
constexpr std::uint16_t a = 1 << 8, b = 1 << 9, y = 1 << 11, start = 1 << 2, right = 1 << 13, left = 1 << 15;
constexpr std::uint16_t damp_keys = l2 | b;

struct KeyName {
    const char* name;
    std::uint16_t keys;
};
constexpr KeyName key_table[]{
    {"R1+B", r1 | b}, {"L2+A", l2 | a}, {"R2+A", r2 | a}, {"R2+B", r2 | b},
    {"R2+Y", r2 | y}, {"L1+A", l1 | a}, {"L2+B", damp_keys},
    {"START+LEFT", start | left}, {"START+RIGHT", start | right},  // factory handover (only when stopped)
};
// App action -> key (apps/agent foothold_agent/go2_direct/actions.py LOWLEVEL).
constexpr std::pair<const char*, const char*> action_table[]{
    {"Sit", "R1+B"}, {"RiseSit", "R1+B"}, {"StandDown", "L2+A"}, {"Stretch", "R2+A"},
    {"Hello", "R2+B"}, {"Heart", "R2+Y"}, {"Damp", "L2+B"}, {"Greet", "L1+A"},
    {"FreeWalk", "START+LEFT"}, {"ClassicWalk", "START+RIGHT"},
};

constexpr unsigned f_seq = 1, f_key = 2, f_action = 4, f_request = 8, f_vx = 16, f_vy = 32, f_wz = 64;

struct Cursor {
    std::string_view text;
    std::size_t at = 0;
    void space() {
        while (at < text.size() && (text[at] == ' ' || text[at] == '\t' || text[at] == '\n' || text[at] == '\r')) ++at;
    }
    bool eat(char c) {
        space();
        if (at < text.size() && text[at] == c) { ++at; return true; }
        return false;
    }
    // Plain printable ASCII without escapes: the connector never needs them.
    bool string(std::string_view& out) {
        if (!eat('"')) return false;
        const auto begin = at;
        while (at < text.size() && text[at] != '"') {
            const auto c = static_cast<unsigned char>(text[at]);
            if (c < 0x20 || c > 0x7e || c == '\\') return false;
            ++at;
        }
        if (at == text.size() || at - begin > 128) return false;
        out = text.substr(begin, at - begin);
        ++at;
        return true;
    }
    bool token(std::string_view& out) {
        space();
        const auto begin = at;
        while (at < text.size() && (std::isdigit(static_cast<unsigned char>(text[at])) || text[at] == '-' ||
                                    text[at] == '+' || text[at] == '.' || text[at] == 'e' || text[at] == 'E'))
            ++at;
        out = text.substr(begin, at - begin);
        return !out.empty();
    }
};

bool real(std::string_view token, double& out) {
    if (token.size() > 32) return false;
    char buffer[33];
    std::copy(token.begin(), token.end(), buffer);
    buffer[token.size()] = 0;
    char* end = nullptr;
    out = std::strtod(buffer, &end);
    return end == buffer + token.size() && std::isfinite(out);
}
}

std::optional<AppPacket> parse_app_packet(std::string_view text, const char*& reason) {
    reason = "malformed";
    if (text.size() > app_packet_max) { reason = "too_large"; return std::nullopt; }
    Cursor in{text};
    if (!in.eat('{')) return std::nullopt;
    unsigned seen = 0;
    AppPacket packet;
    std::string_view key, action, request;
    double v[3]{};
    do {
        std::string_view name;
        if (!in.string(name) || !in.eat(':')) return std::nullopt;
        const unsigned field = name == "seq" ? f_seq : name == "key" ? f_key : name == "action" ? f_action :
                               name == "request_id" ? f_request : name == "vx" ? f_vx : name == "vy" ? f_vy :
                               name == "wz" ? f_wz : 0;
        if (!field || (seen & field)) return std::nullopt;
        seen |= field;
        std::string_view value;
        if (field == f_key || field == f_action || field == f_request) {
            if (!in.string(field == f_key ? key : field == f_action ? action : request)) return std::nullopt;
        } else if (!in.token(value)) {
            return std::nullopt;
        } else if (field == f_seq) {
            // Unsigned decimal integer only (no sign, fraction or exponent).
            if (!std::all_of(value.begin(), value.end(), [](char c) { return c >= '0' && c <= '9'; }))
                return std::nullopt;
            const auto [end, error] = std::from_chars(value.data(), value.data() + value.size(), packet.seq);
            if (error != std::errc{} || end != value.data() + value.size() || packet.seq <= 0) return std::nullopt;
        } else if (!real(value, v[field == f_vx ? 0 : field == f_vy ? 1 : 2])) {
            return std::nullopt;
        }
    } while (in.eat(','));
    if (!in.eat('}')) return std::nullopt;
    in.space();
    if (in.at != text.size() || !(seen & f_seq)) return std::nullopt;

    const unsigned key_fields = f_key | f_action | f_request, velocity_fields = f_vx | f_vy | f_wz;
    if ((seen & ~f_seq) == key_fields) {
        const auto* entry = std::find_if(std::begin(key_table), std::end(key_table),
                                         [&](const KeyName& k) { return key == k.name; });
        const auto* mapped = std::find_if(std::begin(action_table), std::end(action_table),
                                          [&](const auto& pair) { return action == pair.first; });
        if (entry == std::end(key_table) || mapped == std::end(action_table) || key != mapped->second) {
            reason = "key";
            return std::nullopt;
        }
        if (request.empty()) return std::nullopt;
        packet.keys = entry->keys;
        packet.key = entry->name;
        packet.request_id = std::string(request);
        return packet;
    }
    if ((seen & ~f_seq) == velocity_fields) {
        if (std::abs(v[0]) > 2 || std::abs(v[1]) > 2 || std::abs(v[2]) > 3) {
            reason = "velocity";
            return std::nullopt;
        }
        packet.velocity = Wanted{v[0], v[1], v[2]};
        return packet;
    }
    return std::nullopt;
}

std::string ack_json(const AppAck& ack) {
    std::string out = "{\"seq\":" + std::to_string(ack.seq) + ",\"result\":\"" + ack.result + '"';
    if (ack.reason) out += std::string(",\"reason\":\"") + ack.reason + '"';
    if (!ack.request_id.empty()) out += ",\"request_id\":\"" + ack.request_id + '"';
    out += std::string(",\"phase\":\"") + ack.phase + "\",\"remote\":" + (ack.remote ? "true" : "false") + '}';
    return out;
}

void AppInput::drop(Tick now, const char* reason) {
    ++dropped_;
    // A flood of bad packets must not flood the trace: one event per second at most.
    if (!last_drop_event_ || now - *last_drop_event_ >= std::chrono::seconds(1)) {
        last_drop_event_ = now;
        observer_.event(now, Event::app_drop, {reason, double(dropped_)});
    }
}

const char* AppInput::receive(Tick now, std::string_view datagram, std::uint16_t peer) {
    const char* reason = nullptr;
    auto packet = parse_app_packet(datagram, reason);
    if (packet) {
        const Tick stamp{std::chrono::nanoseconds(packet->seq)};
        reason = stamp > now + app_packet_future ? "future" :
                 now - stamp > app_packet_freshness ? "stale" :
                 packet->seq <= last_seq_ ? "seq" : nullptr;
    }
    if (reason) {
        drop(now, reason);
        return reason;
    }
    last_seq_ = packet->seq;
    pending_.push_back({std::move(*packet), peer});
    return nullptr;
}

void AppInput::apply(Tick now, LowState& state) {
    remote_ = remote_active(state.remote);
    std::optional<std::size_t> key;
    for (std::size_t i = 0; i < pending_.size(); ++i) {
        auto& entry = pending_[i];
        if (entry.packet.velocity) {
            if (remote_) {
                entry.ignored = "remote";
                continue;
            }
            const auto& v = *entry.packet.velocity;
            // Same range the stick can ask for (core.cpp remote_want).
            velocity_ = Wanted{std::clamp(v[0], -1.3, fwd_max_), std::clamp(v[1], -.8, .8), std::clamp(v[2], -1.5, 1.5)};
            velocity_stamp_ = Tick{std::chrono::nanoseconds(entry.packet.seq)};
            entry.applied = true;
        } else if (!key || (entry.packet.keys == damp_keys && pending_[*key].packet.keys != damp_keys)) {
            // One key per tick. An app damp in the same batch wins over any other key.
            key = i;
        }
    }
    if (remote_ || (velocity_ && now - velocity_stamp_ > app_velocity_timeout)) velocity_.reset();
    state.app_want = velocity_;
    for (std::size_t i = 0; i < pending_.size(); ++i) {
        auto& entry = pending_[i];
        if (entry.packet.velocity) continue;
        if (!key || i != *key) entry.ignored = "busy";
        else if (remote_ && entry.packet.keys != damp_keys) entry.ignored = "remote";
        else {
            state.remote.keys |= entry.packet.keys;
            entry.applied = true;
        }
    }
}

std::vector<AppAck> AppInput::settle(Tick now, Phase before, Move before_move, Phase after, Move after_move,
                                     const char* refusal) {
    std::vector<AppAck> acks;
    acks.reserve(pending_.size());
    const bool changed = after != before || after_move != before_move;
    for (auto& entry : pending_) {
        AppAck ack{entry.peer, entry.packet.seq, std::move(entry.packet.request_id)};
        ack.phase = phase_name(after);
        ack.remote = remote_;
        if (entry.packet.velocity) {
            ack.result = entry.applied ? "ACCEPTED" : "IGNORED";
            ack.reason = entry.ignored;
        } else {
            const bool started = entry.applied && changed;
            ack.result = started ? "STARTED" : "IGNORED";
            ack.reason = started ? nullptr : entry.applied ? (refusal ? refusal : "phase") : entry.ignored;
            observer_.event(now, Event::app_key, {entry.packet.key, started ? 1. : 0.});
        }
        acks.push_back(std::move(ack));
    }
    pending_.clear();
    return acks;
}

}
