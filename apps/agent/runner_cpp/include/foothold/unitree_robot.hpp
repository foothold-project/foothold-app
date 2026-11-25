#pragma once

#include "foothold/runner.hpp"

#include <memory>
#include <string>

namespace foothold {

class UnitreeRobot final : public Robot {
public:
    UnitreeRobot(const std::string& nic, bool live, std::string factory_mode);
    ~UnitreeRobot() override;
    LowState read();
    RobotMode check_mode() override;
    void release_mode() override;
    bool select_mode() override;
    void recovery_stand() override;
    bool select_gait(Gait) override;
    void send(const Joints& q_sdk, float kp, float kd) override;
    void send_ff(const Joints& q_sdk, const Joints& dq_sdk, const Joints& tau_sdk, float kp, float kd) override;
    std::uint64_t writes() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}
