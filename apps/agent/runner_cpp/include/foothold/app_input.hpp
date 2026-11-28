#pragma once

#include "foothold/runner.hpp"

#include <string>
#include <string_view>
#include <vector>

namespace foothold {

// App input from the connector on the same machine (APP-MOVES.md). One datagram = one flat JSON object.
//   key packet:      {"seq": ns, "key": "R1+B", "action": "Sit", "request_id": "..."}
//   velocity packet: {"seq": ns, "vx": m/s, "vy": m/s, "wz": rad/s}
//   stop packet:     {"seq": ns, "stop": 1}   app STOP: hold want 0 over the physical stick until
//                    {"seq": ns, "stop": 0}   the app release (the connector's unlock). Keys are unchanged.
// seq is the sender's CLOCK_MONOTONIC in nanoseconds (the same clock as steady_clock on Linux).
inline constexpr std::size_t app_packet_max = 512;
inline constexpr auto app_packet_freshness = std::chrono::milliseconds(500);
inline constexpr auto app_packet_future = std::chrono::milliseconds(20);
inline constexpr auto app_velocity_timeout = std::chrono::milliseconds(300);

struct AppPacket {
    std::int64_t seq = 0;
    std::uint16_t keys = 0;      // nonzero for a key packet
    const char* key = nullptr;   // static key name, for the trace
    std::string request_id;
    std::optional<Wanted> velocity;
    std::optional<bool> stop;    // set for a stop packet
};

// Syntax and field check only. Returns the packet or sets `reason` (a static string).
std::optional<AppPacket> parse_app_packet(std::string_view text, const char*& reason);

struct AppAck {
    std::uint16_t peer = 0;
    std::int64_t seq = 0;
    std::string request_id;
    const char* result = "IGNORED";  // STARTED · IGNORED (keys) · ACCEPTED · IGNORED (velocity)
    const char* reason = nullptr;
    const char* phase = "unknown";
    bool remote = false;
};
std::string ack_json(const AppAck&);

// Turns accepted packets into the same inputs the physical remote gives the runner.
// The physical remote wins: while any physical stick or key is non-neutral, app keys and
// velocity are dropped, except the app L2+B (damp), which is always passed through, and the
// app STOP, which holds the walking target at zero over the stick until the app release.
class AppInput {
public:
    explicit AppInput(Observer& observer, double fwd_max = 1.5) : observer_(observer), fwd_max_(fwd_max) {}
    // Returns nullptr when accepted, otherwise the drop reason (no ack for dropped packets).
    const char* receive(Tick now, std::string_view datagram, std::uint16_t peer);
    void drop(Tick now, const char* reason);
    // Before Runner::tick: OR one app key into this tick's keys, set the app velocity.
    void apply(Tick now, LowState& state);
    // After Runner::tick: results for every packet received since the last settle.
    // `refusal` is Runner::refusal() (e.g. not_stopped for a factory handover while moving).
    std::vector<AppAck> settle(Tick now, Phase before, Move before_move, Phase after, Move after_move,
                               const char* refusal = nullptr);
    std::uint64_t dropped() const { return dropped_; }

private:
    struct Pending {
        AppPacket packet;
        std::uint16_t peer;
        const char* ignored = nullptr;  // set by apply when the packet was not used
        bool applied = false;
    };
    Observer& observer_;
    double fwd_max_;
    std::int64_t last_seq_ = 0;
    std::vector<Pending> pending_;
    std::optional<Wanted> velocity_;
    Tick velocity_stamp_{};
    bool remote_ = false;
    bool stop_ = false;
    std::uint64_t dropped_ = 0;
    std::optional<Tick> last_drop_event_;
};

}
