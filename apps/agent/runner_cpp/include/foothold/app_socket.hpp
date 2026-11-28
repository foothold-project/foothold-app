#pragma once

#include "foothold/app_input.hpp"

namespace foothold {

// New random session token (32 hex) written to `path` as a fresh 0600 file owned by this user.
// Throws when the file cannot be made that way. The value is never logged.
std::string write_app_token(const char* path);

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
