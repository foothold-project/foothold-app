#include "foothold/unitree_robot.hpp"

#include <unitree/idl/go2/LowCmd_.hpp>
#include <unitree/idl/go2/LowState_.hpp>
#include <unitree/robot/b2/motion_switcher/motion_switcher_client.hpp>
#include <unitree/robot/channel/channel_publisher.hpp>
#include <unitree/robot/channel/channel_subscriber.hpp>
#include <unitree/robot/go2/sport/sport_client.hpp>

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <type_traits>

namespace foothold {
namespace {
using unitree_go::msg::dds_::LowCmd_;
using unitree_go::msg::dds_::LowState_;
using unitree::robot::ChannelPublisher;
using unitree::robot::ChannelSubscriber;

std::uint32_t low_cmd_crc(const LowCmd_& cmd) {
    // SDK2's LowCmd wire CRC processes each little-endian word MSB first.
    static_assert(std::is_standard_layout_v<LowCmd_> && sizeof(LowCmd_) % 4 == 0);
    const auto* bytes = reinterpret_cast<const unsigned char*>(&cmd);
    std::uint32_t crc = 0xffffffff;
    for (std::size_t i = 0; i < sizeof(cmd) - 4; i += 4) {
        std::uint32_t word;
        std::memcpy(&word, bytes + i, sizeof(word));
        crc ^= word;
        for (int bit = 0; bit < 32; ++bit)
            crc = (crc << 1) ^ ((crc >> 31) ? 0x04c11db7u : 0);
    }
    return crc;
}
}

struct UnitreeRobot::Impl {
    std::mutex mutex;
    LowState latest{}, snapshot{};
    LowCmd_ cmd{};
    std::unique_ptr<ChannelPublisher<LowCmd_>> publisher;
    std::unique_ptr<unitree::robot::b2::MotionSwitcherClient> switcher;
    std::unique_ptr<unitree::robot::go2::SportClient> sport;
    std::string factory_mode;
    std::uint64_t sent = 0;
    bool owned = false, selecting = false;
    std::atomic<bool> emergency{false};
    ChannelSubscriber<LowState_> subscriber{"rt/lowstate"};

    Impl(const std::string& nic, bool live, std::string mode) : factory_mode(std::move(mode)) {
        unitree::robot::ChannelFactory::Instance()->Init(0, nic);
        subscriber.InitChannel([this](const void* data) { receive(*static_cast<const LowState_*>(data)); }, 1);
        if (!live) return;
        publisher = std::make_unique<ChannelPublisher<LowCmd_>>("rt/lowcmd");
        publisher->InitChannel();
        switcher = std::make_unique<unitree::robot::b2::MotionSwitcherClient>();
        switcher->SetTimeout(1.f);
        switcher->Init();
        sport = std::make_unique<unitree::robot::go2::SportClient>();
        sport->SetTimeout(1.f);
        sport->Init();
        cmd.head() = {0xfe, 0xef};
        cmd.level_flag() = 0xff;
        for (auto& motor : cmd.motor_cmd()) {
            motor.mode() = 1;
            motor.q() = 2.146e9f;
            motor.dq() = 16000.f;
        }
    }

    void receive(const LowState_& msg) {
        LowState state;
        state.stamp = std::chrono::steady_clock::now();
        state.orientation = msg.imu_state().quaternion();
        state.gyro = msg.imu_state().gyroscope();
        state.remote = parse_remote(msg.wireless_remote());
        constexpr auto l2_b = (1 << 5) | (1 << 9);
        emergency.store((state.remote.keys & l2_b) == l2_b, std::memory_order_release);
        for (std::size_t i = 0; i < state.q.size(); ++i) {
            const auto& motor = msg.motor_state()[i];
            state.q[i] = motor.q();
            state.dq[i] = motor.dq();
            state.tau[i] = motor.tau_est();
            state.temperature[i] = motor.temperature();
        }
        std::copy(msg.foot_force().begin(), msg.foot_force().end(), state.foot.begin());
        const auto& bms = msg.bms_state();
        state.battery = Battery{static_cast<float>(bms.soc()), msg.power_v(), msg.power_a(),
                                {bms.bq_ntc()[0], bms.bq_ntc()[1]}, {bms.mcu_ntc()[0], bms.mcu_ntc()[1]}};
        std::lock_guard lock(mutex);
        latest = state;
    }
};

UnitreeRobot::UnitreeRobot(const std::string& nic, bool live, std::string factory_mode)
    : impl_(std::make_unique<Impl>(nic, live, std::move(factory_mode))) {}
UnitreeRobot::~UnitreeRobot() = default;

LowState UnitreeRobot::read() {
    std::unique_lock lock(impl_->mutex, std::try_to_lock);
    if (lock.owns_lock()) impl_->snapshot = impl_->latest;
    return impl_->snapshot;
}

RobotMode UnitreeRobot::check_mode() {
    if (!impl_->switcher) return RobotMode::unknown;
    std::string form, name;
    if (impl_->switcher->CheckMode(form, name) != 0) {
        impl_->owned = false;
        return RobotMode::unknown;
    }
    if (impl_->selecting && name != impl_->factory_mode) return RobotMode::unknown;
    impl_->selecting = false;
    impl_->owned = name.empty();
    if (impl_->owned) return RobotMode::low;
    impl_->factory_mode = std::move(name);
    return RobotMode::factory;
}

void UnitreeRobot::release_mode() {
    if (impl_->switcher) impl_->switcher->ReleaseMode();
}
bool UnitreeRobot::select_mode() {
    impl_->owned = false;
    impl_->selecting = true;
    return impl_->switcher && impl_->switcher->SelectMode(impl_->factory_mode) == 0;
}
void UnitreeRobot::recovery_stand() {
    if (impl_->sport) impl_->sport->RecoveryStand();
}
bool UnitreeRobot::select_gait(Gait gait) {
    if (!impl_->sport) return false;
    if (gait == Gait::free_walk) return impl_->sport->FreeWalk() == 0;
    return gait == Gait::classic && impl_->sport->ClassicWalk(true) == 0;
}
void UnitreeRobot::send(const Joints& q, float kp, float kd) {
    if (!impl_->publisher || !impl_->owned ||
        (kp > 0 && impl_->emergency.load(std::memory_order_acquire))) return;
    for (std::size_t i = 0; i < q.size(); ++i) {
        auto& motor = impl_->cmd.motor_cmd()[i];
        motor.q() = q[i];
        motor.dq() = 0;
        motor.kp() = kp;
        motor.kd() = kd;
        motor.tau() = 0;
    }
    impl_->cmd.crc() = low_cmd_crc(impl_->cmd);
    if (!impl_->publisher->Write(impl_->cmd)) throw std::runtime_error("LowCmd write failed");
    ++impl_->sent;
}
std::uint64_t UnitreeRobot::writes() const { return impl_->sent; }

}
