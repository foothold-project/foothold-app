#include "foothold/app_socket.hpp"

#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <sys/stat.h>
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
    require(parses(R"({"seq":5,"token":"t","key":"R1+B","action":"Sit","request_id":"r-1"})"), "key packet");
    require(parses(R"( { "seq" : 5 , "token" : "t" , "vx" : -0.5 , "vy" : 0 , "wz" : 1e-1 } )"), "velocity packet with spaces");
    require(parses(R"({"seq":5,"token":"t","key":"R1+B","action":"Sit","request_id":"r","vx":0})", "malformed"), "mixed packet");
    require(parses(R"({"seq":5,"token":"t","seq":6,"vx":0,"vy":0,"wz":0})", "malformed"), "duplicate field");
    require(parses(R"({"seq":5,"token":"t","vx":0,"vy":0,"wz":0,"mode":"start"})", "malformed"), "unknown field");
    require(parses(R"({"seq":5.0,"token":"t","vx":0,"vy":0,"wz":0})", "malformed"), "fractional seq");
    require(parses(R"({"seq":5,"token":"t","vx":0,"vy":0,"wz":0}x)", "malformed"), "trailing bytes");
    require(parses(R"({"seq":5,"token":"t","vx":2.5,"vy":0,"wz":0})", "velocity"), "velocity out of range");
    require(parses(R"({"seq":5,"token":"t","key":"R1+B","action":"Sit","request_id":"a\"b"})", "malformed"), "escape in id");
    require(parses(R"({"seq":5,"token":"t","key":"R1+B","action":"Sit","request_id":""})", "malformed"), "empty id");
    require(parses(R"({"seq":5,"token":"t","key":"L2+B","action":"Sit","request_id":"x"})", "key"), "action/key mismatch");
    require(parses(R"({"seq":99999999999999999999,"token":"t","vx":0,"vy":0,"wz":0})", "malformed"), "seq overflow");
    // App STOP (11/28): {"seq", "stop": 1} holds zero, {"stop": 0} releases. Nothing else.
    {
        const char* reason = nullptr;
        const auto on = parse_app_packet(R"({"seq":5,"token":"t","stop":1,"id":3})", reason);
        const auto off = parse_app_packet(R"({"seq":6,"token":"t","stop":0,"id":3})", reason);
        require(on && on->stop == std::optional<bool>(true) && on->stop_id == 3 && on->token == "t" && !on->velocity &&
                    !on->keys, "stop packet");
        require(off && off->stop == std::optional<bool>(false), "release packet");
    }
    require(parses(R"({"seq":5,"token":"t","stop":2})", "malformed"), "stop value other than 0 or 1");
    require(parses(R"({"seq":5,"token":"t","stop":1.0})", "malformed"), "fractional stop");
    require(parses(R"({"seq":5,"token":"t","stop":1,"id":3,"vx":0,"vy":0,"wz":0})", "malformed"), "stop mixed with velocity");
    require(parses(R"({"seq":5,"token":"t","stop":1})", "malformed"), "stop without its id");
    require(parses(R"({"seq":5,"token":"t","stop":0,"id":0})", "malformed"), "stop id must be positive");
    // Codex pr550 H3: every packet carries the session token.
    require(parses(R"({"seq":5,"vx":0,"vy":0,"wz":0})", "malformed"), "velocity without token");
    require(parses(R"({"seq":5,"key":"R1+B","action":"Sit","request_id":"r"})", "malformed"), "key without token");
    require(parses(R"({"seq":5,"token":"","vx":0,"vy":0,"wz":0})", "malformed"), "empty token");

    AppAck ack{1, 7, "id-1", "STARTED", nullptr, "policy", false, true};
    require(ack_json(ack) == R"({"seq":7,"result":"STARTED","request_id":"id-1","phase":"policy","remote":false,"stopped":true})",
            "ack json");

    // Loopback round trip: datagram in, ack back to the sender's port.
    Quiet quiet;
    const std::string token = "0123456789abcdef0123456789abcdef";
    AppInput input(quiet, token);
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
    {
        // Fresh input holds the app STOP (SF-02): release it first, as the connector's unlock does.
        LowState locked;
        input.receive(now - 1ms, "{\"seq\":" + std::to_string(seq - 1000000) + ",\"token\":\"" + token +
                                     "\",\"stop\":0,\"id\":1}", 1);
        input.apply(now - 1ms, locked);
        input.settle(now - 1ms, Phase::policy, Move::dog_sit, Phase::policy, Move::dog_sit);
        require(!locked.app_stop, "release");
    }
    const auto body = "{\"seq\":" + std::to_string(seq) + ",\"token\":\"" + token + "\",\"vx\":0.3,\"vy\":0,\"wz\":0}";
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
                            "{\"seq\":" + std::to_string(seq) + ",\"result\":\"ACCEPTED\",\"phase\":\"policy\",\"remote\":false,\"stopped\":false}",
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
    {
        // Codex pr550 H3: the session token file is a fresh 0600 file of 32 hex, new on every start.
        const std::string path = "/tmp/foothold-app-token-test-" + std::to_string(getpid());
        const auto first = write_app_token(path.c_str()), second = write_app_token(path.c_str());
        struct stat info{};
        require(stat(path.c_str(), &info) == 0 && (info.st_mode & 0777) == 0600 && info.st_uid == geteuid(), "token file 0600");
        FILE* file = std::fopen(path.c_str(), "r");
        char text[64]{};
        const auto size = std::fread(text, 1, sizeof(text) - 1, file);
        std::fclose(file);
        require(first.size() == 32 && first != second && std::string_view(text, size) == second, "token value");
        unlink(path.c_str());
        // A symlink planted at the path is replaced, never followed.
        const std::string target = path + "-target";
        require(symlink(target.c_str(), path.c_str()) == 0, "symlink");
        write_app_token(path.c_str());
        require(access(target.c_str(), F_OK) != 0, "token must not be written through a symlink");
        unlink(path.c_str());
    }
    std::cout << "app input ok\n";
}
