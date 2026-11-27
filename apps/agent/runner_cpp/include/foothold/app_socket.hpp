#pragma once

#include "foothold/app_input.hpp"

namespace foothold {

// 127.0.0.1 UDP socket for app input (--app-port). Nonblocking: one poll per control tick
// reads every waiting datagram; packets from any other address are dropped.
class AppSocket {
public:
    explicit AppSocket(std::uint16_t port);
    ~AppSocket();
    AppSocket(const AppSocket&) = delete;
    AppSocket& operator=(const AppSocket&) = delete;
    void poll(Tick now, AppInput& input);
    // Best effort: a lost ack leaves the connector at RUNNER_SENT.
    void reply(const std::vector<AppAck>& acks);
    std::uint16_t port() const;

private:
    int fd_;
};

}
