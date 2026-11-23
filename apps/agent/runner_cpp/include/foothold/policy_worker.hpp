#pragma once

#include "foothold/runner.hpp"

#include <memory>

namespace foothold {

class PolicyWorker final : public PolicyExecutor {
public:
    PolicyWorker(Policy&, int rt_priority);
    ~PolicyWorker() override;
    void submit(const Inputs&) override;
    Inference poll(Outputs&) override;
    bool realtime() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}
