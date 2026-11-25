#pragma once

#include "foothold/runner.hpp"

#include <memory>
#include <pthread.h>

namespace foothold {

class PolicyWorker final : public PolicyExecutor {
public:
    PolicyWorker(Policy&, int rt_priority);
    ~PolicyWorker() override;
    void submit(const Inputs&) override;
    Inference poll(Outputs&) override;
    bool realtime() const;
    pthread_t thread() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}
