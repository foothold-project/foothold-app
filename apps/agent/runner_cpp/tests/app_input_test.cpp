#include "foothold/app_socket.hpp"

#include <cstdlib>
#include <cstring>
#include <iostream>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

using namespace foothold;
using namespace std::chrono_literals;

namespace {
void require(bool pass, const char* message) {
    if (pass) return;
    std::cerr << message << '\n';
    std::exit(1);
}

struct Quiet final : Observer {};

bool parses(std::string_view text, const char* expected_reason = nullptr) {
    const char* reason = nullptr;
    const bool ok = parse_app_packet(text, reason).has_value();
    if (expected_reason) return !ok && std::string_view(reason) == expected_reason;
    return ok;
}
}

int main() {
    // Parser: exact fields only.
    require(parses(R"({"seq":5,"key":"R1+B","action":"Sit","request_id":"r-1"})"), "key packet");
    require(parses(R"( { "seq" : 5 , "vx" : -0.5 , "vy" : 0 , "wz" : 1e-1 } )"), "velocity packet with spaces");
    require(parses(R"({"seq":5,"key":"R1+B","action":"Sit","request_id":"r","vx":0})", "malformed"), "mixed packet");
    require(parses(R"({"seq":5,"seq":6,"vx":0,"vy":0,"wz":0})", "malformed"), "duplicate field");
    require(parses(R"({"seq":5,"vx":0,"vy":0,"wz":0,"mode":"start"})", "malformed"), "unknown field");
    require(parses(R"({"seq":5.0,"vx":0,"vy":0,"wz":0})", "malformed"), "fractional seq");
    require(parses(R"({"seq":5,"vx":0,"vy":0,"wz":0}x)", "malformed"), "trailing bytes");
    require(parses(R"({"seq":5,"vx":2.5,"vy":0,"wz":0})", "velocity"), "velocity out of range");
    require(parses(R"({"seq":5,"key":"R1+B","action":"Sit","request_id":"a\"b"})", "malformed"), "escape in id");
    require(parses(R"({"seq":5,"key":"R1+B","action":"Sit","request_id":""})", "malformed"), "empty id");
    require(parses(R"({"seq":5,"key":"L2+B","action":"Sit","request_id":"x"})", "key"), "action/key mismatch");
    require(parses(R"({"seq":99999999999999999999,"vx":0,"vy":0,"wz":0})", "malformed"), "seq overflow");

    AppAck ack{1, 7, "id-1", "STARTED", nullptr, "policy", false};
    require(ack_json(ack) == R"({"seq":7,"result":"STARTED","request_id":"id-1","phase":"policy","remote":false})",
            "ack json");

    // Loopback round trip: datagram in, ack back to the sender's port.
    Quiet quiet;
    AppInput input(quiet);
    AppSocket socket_in(0);
    const int sender = socket(AF_INET, SOCK_DGRAM, 0);
    require(sender >= 0, "sender socket");
    sockaddr_in to{};
    to.sin_family = AF_INET;
    to.sin_port = htons(socket_in.port());
    to.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    timeval timeout{1, 0};
    setsockopt(sender, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    const auto now = std::chrono::steady_clock::now();
    const auto seq = std::chrono::duration_cast<std::chrono::nanoseconds>(now.time_since_epoch()).count();
    const auto body = "{\"seq\":" + std::to_string(seq) + ",\"vx\":0.3,\"vy\":0,\"wz\":0}";
    require(sendto(sender, body.data(), body.size(), 0, reinterpret_cast<sockaddr*>(&to), sizeof(to)) ==
                static_cast<ssize_t>(body.size()), "send packet");
    const std::string big(app_packet_max + 1, ' ');
    sendto(sender, big.data(), big.size(), 0, reinterpret_cast<sockaddr*>(&to), sizeof(to));
    usleep(20000);
    socket_in.poll(now + 1ms, input);
    require(input.dropped() == 1, "oversized datagram must be dropped");
    LowState state;
    input.apply(now + 1ms, state);
    require(state.app_want && (*state.app_want)[0] == .3, "velocity must be applied");
    socket_in.reply(input.settle(now + 1ms, Phase::policy, Move::dog_sit, Phase::policy, Move::dog_sit));
    char reply[256]{};
    const auto size = recv(sender, reply, sizeof(reply) - 1, 0);
    require(size > 0 && std::string_view(reply, size) ==
                            "{\"seq\":" + std::to_string(seq) + ",\"result\":\"ACCEPTED\",\"phase\":\"policy\",\"remote\":false}",
            "ack must come back to the sender");
    input.apply(now + 302ms, state);
    require(!state.app_want, "velocity must expire after 0.3 s");
    close(sender);
    bool refused = false;
    try {
        AppSocket low(80);
    } catch (const std::invalid_argument&) {
        refused = true;
    }
    require(refused, "privileged port must be refused");
    std::cout << "app input ok\n";
}
